/**
 * Fully dereference the bundled UCP checkout schema and extract the REAL,
 * self-contained sub-schema at any JSONPath.
 *
 * The UCP `shopping/checkout.json` composes via relative-file `$ref`
 * (`types/buyer.json`, `types/line_item.json`, `../ucp.json#/…`, …) and `allOf`.
 * Every schema carries an absolute `$id` (`https://ucp.dev/schemas/…`), so a
 * relative `$ref` resolves against that URL base — we intercept that URL space
 * with a {@link localResolver} that reads from the bundled `./ucp/` copy, so the
 * whole graph resolves offline with NO sibling-repo dependency.
 *
 * Pipeline:
 *   1. `@apidevtools/json-schema-ref-parser` `dereference` (circular:true) inlines
 *      every `$ref` — the one self-referential branch (`$.payment`) is inlined as
 *      an object reference, so the result has ZERO `$ref` keys.
 *   2. `json-schema-merge-allof` folds `allOf` (with a `defaultResolver` catch-all
 *      for conditional keywords like `if`/`then`/`contains`) into a plain object
 *      at each node we walk, so the sub-schema at a path has a real
 *      `type`/`enum`/`format`/constraints and no `allOf`.
 *
 * Bundled UCP schemas: copied from ucp `source/schemas` @ 7e5fc42 (2026-07-03).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import $RefParser from '@apidevtools/json-schema-ref-parser';
import mergeAllOf from 'json-schema-merge-allof';

import type { JSONSchema } from './json-schema';
import { toSegments, UnsupportedPathError } from './jsonpath';

/** Absolute base every bundled UCP schema advertises via its `$id`. */
const UCP_URL_BASE = 'https://ucp.dev/';
/** On-disk root of the bundled `source/schemas` copy. */
const BUNDLE_ROOT = fileURLToPath(new URL('./ucp/', import.meta.url));
/** Entry point of the checkout schema graph. */
const CHECKOUT_ENTRY = fileURLToPath(new URL('./ucp/shopping/checkout.json', import.meta.url));

/**
 * A ref-parser resolver that maps the `https://ucp.dev/schemas/…` `$id` URL space
 * onto the bundled copy on disk, so relative `$ref`s resolve without any network.
 */
const localResolver = {
  order: 1,
  canRead: (file: { url: string }): boolean =>
    typeof file.url === 'string' && file.url.startsWith(UCP_URL_BASE),
  read: (file: { url: string }): string => {
    const rel = decodeURIComponent(
      file.url.replace(/^https:\/\/ucp\.dev\/schemas\//, '').replace(/^https:\/\/ucp\.dev\//, '').split('#')[0] ?? ''
    );
    return readFileSync(BUNDLE_ROOT + rel, 'utf8');
  },
};

/**
 * Non-JSON-Schema / meta keys stripped from a returned field schema.
 *
 * `$defs`/`definitions` (and the other non-instance keywords) are DEFINITION
 * carriers, not field constraints — and crucially `$defs` is what carries the
 * self-referential cycle in the payment schema (`selected_payment_instrument`'s
 * `allOf[0]` points back at the payment_instrument root, which contains that
 * `$defs`). Stripping them makes the returned field schema acyclic + JSON-
 * serialisable and lets `allOf` be merged recursively without looping.
 */
const META_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'definitions',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$vocabulary',
  'ucp_request',
  'name',
]);

/** Cached, fully-dereferenced ($ref-free) checkout schema. */
let cached: Promise<JSONSchema> | undefined;

/**
 * Load + fully dereference the bundled UCP checkout schema (cached). The result
 * is `$ref`-free (circular branches inlined as object references).
 */
export function loadCheckoutSchema(): Promise<JSONSchema> {
  if (!cached) {
    cached = $RefParser
      .dereference(CHECKOUT_ENTRY, { resolve: { ucp: localResolver } })
      .then((schema) => schema as JSONSchema)
      .catch((err: unknown) => {
        // Reset so a transient failure can be retried by the next caller.
        cached = undefined;
        throw err;
      });
  }
  return cached;
}

/** `defaultResolver`: keep the first defined value for any keyword the library can't merge. */
function firstDefined(values: unknown[]): unknown {
  return values.find((v) => v !== undefined);
}

/**
 * Fold `allOf` throughout `schema` into plain objects. `json-schema-merge-allof`
 * walks the whole tree, so this merges NESTED `allOf` (inside `properties`,
 * `items`, …) too — not just the outermost node. The top-level `allOf` fast path
 * is a no-op optimisation for navigation; the final return runs the full merge on
 * a `$defs`-stripped (hence acyclic) subtree so no `allOf` survives anywhere.
 */
function flattenAllOf(schema: JSONSchema): JSONSchema {
  if (!schema.allOf) return schema;
  return mergeAllOf<JSONSchema>(schema, {
    ignoreAdditionalProperties: true,
    resolvers: { defaultResolver: firstDefined },
  });
}

/**
 * Recursively merge every `allOf` in `schema` (at any depth) into plain objects.
 * MUST be called on an acyclic schema (i.e. after {@link stripMeta} has removed
 * `$defs`); otherwise the library recurses into the payment self-reference. Falls
 * back to the input if the library still cannot merge a node (best-effort).
 */
function deepMergeAllOf(schema: JSONSchema): JSONSchema {
  try {
    return mergeAllOf<JSONSchema>(schema, {
      ignoreAdditionalProperties: true,
      resolvers: { defaultResolver: firstDefined },
    });
  } catch {
    return schema;
  }
}

/** Recursively drop meta/non-standard keys from a (small, acyclic) field schema. */
function stripMeta(schema: JSONSchema, seen = new Set<unknown>()): JSONSchema {
  if (seen.has(schema)) return schema;
  seen.add(schema);
  const out: JSONSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_KEYS.has(key)) continue;
    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        out[key] = value.map((v) =>
          v !== null && typeof v === 'object' ? stripMeta(v as JSONSchema, seen) : v
        );
      } else {
        out[key] = stripMeta(value as JSONSchema, seen);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Read the element schema of an array node for an index/wildcard/filter segment. */
function elementSchema(node: JSONSchema): JSONSchema | undefined {
  const items = node.items;
  if (!items) return undefined;
  if (Array.isArray(items)) return items[0]; // UCP arrays are homogeneous; tuple → best-effort first
  return items;
}

/**
 * Resolve the REAL sub-schema at `jsonPath` inside the checkout schema.
 *
 * Walks the dereferenced schema segment by segment, flattening `allOf` at any
 * node whose children are hidden behind it, following `properties` for object
 * keys and `items` for index/wildcard/filter segments (array elements are
 * homogeneous, so the concrete index/filter maps to the same element schema —
 * hence no instance is required for schema navigation). The returned schema is
 * `$ref`/`allOf`-free with a real `type`/constraints/`format`/`enum`.
 *
 * @throws {UnsupportedPathError} when the path cannot map to a single field schema.
 */
export async function resolveFieldSchemaAtPath(jsonPath: string): Promise<JSONSchema> {
  const segments = toSegments(jsonPath);
  if (segments.length === 0) {
    throw new UnsupportedPathError(`path '${jsonPath}' does not address a field`);
  }

  let node: JSONSchema = await loadCheckoutSchema();
  try {
    for (const seg of segments) {
      node = flattenAllOf(node);
      if (seg.kind === 'key') {
        const props = node.properties;
        let next = props ? props[seg.key] : undefined;
        if (!next && node.additionalProperties && typeof node.additionalProperties === 'object') {
          next = node.additionalProperties;
        }
        if (!next) {
          throw new UnsupportedPathError(
            `no schema for key '${seg.key}' in '${jsonPath}' (not a declared property)`
          );
        }
        node = next;
      } else {
        // index | wildcard | filter → array element schema
        const el = elementSchema(node);
        if (!el) {
          throw new UnsupportedPathError(
            `segment of '${jsonPath}' indexes an array but the schema has no 'items'`
          );
        }
        node = el;
      }
    }
  } catch (err) {
    if (err instanceof UnsupportedPathError) throw err;
    throw new UnsupportedPathError(
      `failed to resolve '${jsonPath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Strip meta FIRST — removing `$defs` breaks the payment self-reference cycle —
  // so the recursive `allOf` merge runs on an acyclic subtree and the result is
  // fully typed ($ref/allOf/$defs-free) and JSON-serialisable everywhere.
  return deepMergeAllOf(stripMeta(node));
}
