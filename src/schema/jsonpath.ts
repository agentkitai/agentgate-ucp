/**
 * RFC-9535 JSONPath helpers (backed by `jsonpath-plus`), used two ways:
 *
 *  - {@link readAtPath} reads the agent-known value at a message's `path`
 *    (prefill). {@link writeAtPath} writes the human's answer back at that path,
 *    creating intermediates — but ONLY for a singular, writable, pollution-safe
 *    path (child key, non-negative index, bracket-quoted key). A buyer-input
 *    field must map to exactly one concrete location, so wildcard/descendant/
 *    filter/negative-index paths and prototype-pollution keys are rejected.
 *  - {@link toSegments} normalises a path into typed segments the SCHEMA walker
 *    (`deref.ts`) follows (`properties` for keys, `items` for array segments),
 *    handling bracket-quoted keys, numeric indices, wildcards, and filters. It
 *    rejects the forbidden keys `__proto__`/`constructor`/`prototype` in ANY
 *    segment, so no crafted path can reach the prototype chain.
 *
 * A path that genuinely cannot map to a single writable field is signalled with
 * {@link UnsupportedPathError} (the caller falls back to the raw escalation).
 */
import { JSONPath } from 'jsonpath-plus';

/** Thrown when a JSONPath cannot be mapped to a single writable/typed field. */
export class UnsupportedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPathError';
  }
}

/**
 * Keys that must NEVER be traversed or created. Descending into (or assigning to)
 * any of these lets a crafted merchant path or field value reach the prototype
 * chain — e.g. `$.a.__proto__[0]` would resolve `__proto__` to `Object.prototype`
 * and `writeAtPath` would then set `Object.prototype['0']` process-wide. We reject
 * them in ANY segment, so they can neither be walked into nor materialised.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Hard cap on a JSONPath string length before it is parsed. The `path` on a
 * buyer-input message is MERCHANT-controlled, and `jsonpath-plus`'s tokenizer is
 * O(n²) in the path length — a ~400 KB `$.x.x.x…` path blocks the single-threaded
 * event loop for tens of seconds (a merchant-triggered DoS of the whole gate). A
 * real field path is a handful of segments; 2 KB is far above any legitimate one.
 */
const MAX_PATH_LEN = 2048;

/** Reject an over-long path BEFORE any (quadratic) parse. */
function assertPathLengthOk(path: string): void {
  if (path.length > MAX_PATH_LEN) {
    throw new UnsupportedPathError(
      `JSONPath exceeds ${MAX_PATH_LEN} chars (got ${path.length}) — refusing to parse (DoS guard)`
    );
  }
}

/** True if `key` is a prototype-pollution vector we must never traverse/create. */
function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

/** A normalised path step. */
export type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'filter'; expr: string };

/** True for segments that address a single, statically-known location. */
function isSingularSegment(seg: PathSegment): boolean {
  return seg.kind === 'key' || seg.kind === 'index';
}

/**
 * True for a segment that addresses exactly ONE concrete, writable location:
 * an object key or a NON-NEGATIVE array index. Wildcards, filters, recursive
 * descent, and negative indices (which `jsonpath-plus` will not resolve for a
 * fresh write) are all excluded — none can be a single form-field target.
 */
function isWritableSingularSegment(seg: PathSegment): boolean {
  return seg.kind === 'key' || (seg.kind === 'index' && seg.index >= 0);
}

/** True when every segment is singular (no wildcard/filter/recursive-descent). */
export function isSingularPath(path: string): boolean {
  return toSegments(path).every(isSingularSegment);
}

/**
 * True when `path` addresses exactly one concrete, WRITABLE location — the only
 * shape a single buyer-input form field may map to. This is the correct
 * semantics for a single-field write (a filter/wildcard selecting many locations,
 * or a negative index jsonpath-plus won't resolve on a fresh object, cannot be a
 * single form field), NOT a shortcut. See {@link assertWritableSingularPath}.
 */
export function isWritableSingularPath(path: string): boolean {
  return toSegments(path).every(isWritableSingularSegment);
}

/**
 * Throw {@link UnsupportedPathError} unless `path` is a singular, writable,
 * pollution-safe location (child key, non-negative index, or bracket-quoted key).
 * The buyer-input builder calls this so wildcard/descendant/filter/negative and
 * forbidden-key paths degrade to the raw escalation instead of fanning out,
 * clobbering, or reaching the prototype chain.
 */
export function assertWritableSingularPath(path: string): void {
  const segments = toSegments(path); // also rejects any forbidden key
  if (segments.length === 0) {
    throw new UnsupportedPathError(`path '${path}' does not address a writable field`);
  }
  if (!segments.every(isWritableSingularSegment)) {
    throw new UnsupportedPathError(
      `path '${path}' is not a singular writable location — a buyer-input field must map to exactly ONE ` +
        `concrete location (child key, non-negative index, or bracket-quoted key); ` +
        `wildcard/descendant/filter/negative-index paths are rejected`
    );
  }
}

/**
 * Classify one raw `toPathArray` element (already unquoted by jsonpath-plus).
 * `quoted` marks a BRACKET-QUOTED segment (`['0']`/`["0"]`): such a segment is
 * ALWAYS a string key, even when numeric — only a BARE `[0]` is an array index.
 * This aligns write/deref with `readAtPath` (jsonpath-plus reads `$.a['0']` as the
 * property "0", not element 0).
 */
function classify(raw: string, quoted: boolean): PathSegment {
  if (!quoted) {
    if (raw === '*' || raw === '..') return { kind: 'wildcard' };
    if (raw.startsWith('?')) return { kind: 'filter', expr: raw };
    if (/^-?\d+$/.test(raw)) return { kind: 'index', index: Number(raw) };
  }
  return { kind: 'key', key: raw };
}

/**
 * Per-segment "was this bracket-quoted?" flags, parsed from the RAW path in the
 * SAME order `toPathArray` segments the path. `toPathArray` normalises `['0']` and
 * `[0]` to the identical `"0"`, discarding the quoting we need to tell a string key
 * from an array index — so we recover it here. Returns `undefined` (⇒ caller treats
 * everything as unquoted, the pre-existing behaviour) for any shape this small
 * tokenizer does not recognise (e.g. `$..key` recursive descent), so we never
 * mis-segment; the quoting fix only kicks in for the simple dot/bracket paths where
 * it matters.
 */
function bracketQuotingFlags(path: string): boolean[] | undefined {
  const flags: boolean[] = [];
  let i = 0;
  const n = path.length;
  if (path[i] !== '$') return undefined;
  i++;
  while (i < n) {
    const ch = path[i]!;
    if (ch === '.') {
      if (path[i + 1] === '.') return undefined; // '..' recursive descent → bail to fallback
      i++; // consume '.'
      if (path[i] === '*') {
        flags.push(false);
        i++;
        continue;
      }
      const start = i;
      while (i < n && path[i] !== '.' && path[i] !== '[') i++;
      if (i === start) return undefined; // empty dot segment → malformed, bail
      flags.push(false); // a dot key is never bracket-quoted
      continue;
    }
    if (ch === '[') {
      i++; // consume '['
      while (i < n && /\s/.test(path[i]!)) i++;
      const q = path[i];
      if (q === "'" || q === '"') {
        i++;
        while (i < n && path[i] !== q) {
          if (path[i] === '\\') i++;
          i++;
        }
        if (i >= n) return undefined; // unterminated quote → bail
        i++; // closing quote
        while (i < n && /\s/.test(path[i]!)) i++;
        if (path[i] !== ']') return undefined;
        i++; // closing ]
        flags.push(true); // bracket-QUOTED key
        continue;
      }
      // Bare bracket: index/wildcard/filter — consume to the matching ], skipping
      // any quoted content inside a filter so its brackets don't confuse the depth.
      let depth = 1;
      while (i < n && depth > 0) {
        const c = path[i]!;
        if (c === "'" || c === '"') {
          i++;
          while (i < n && path[i] !== c) {
            if (path[i] === '\\') i++;
            i++;
          }
        } else if (c === '[') depth++;
        else if (c === ']') depth--;
        i++;
      }
      if (depth !== 0) return undefined; // unbalanced → bail
      flags.push(false);
      continue;
    }
    return undefined; // anything else (e.g. a key right after '..') → bail
  }
  return flags;
}

/**
 * Normalise a JSONPath into typed segments (dropping the leading `$`). Uses
 * `jsonpath-plus`'s own tokenizer for the segment VALUES (so dot keys, indices,
 * wildcards, and filters are consistent) plus a raw-path pass to recover whether
 * each segment was bracket-quoted (a distinction `toPathArray` discards).
 */
export function toSegments(path: string): PathSegment[] {
  assertPathLengthOk(path); // DoS guard: reject before the O(n²) tokenizer
  let parts: unknown;
  try {
    parts = JSONPath.toPathArray(path);
  } catch (err) {
    throw new UnsupportedPathError(
      `not a valid JSONPath '${path}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parts)) {
    throw new UnsupportedPathError(`not a valid JSONPath '${path}'`);
  }
  // parts[0] is '$'; classify the rest, folding in per-segment quoting when we can
  // reliably recover it (else every segment is treated as unquoted — legacy behaviour).
  const values = parts.slice(1);
  const quoting = bracketQuotingFlags(path);
  const quotedAt = quoting && quoting.length === values.length ? quoting : undefined;
  const segments = values.map((p, idx) => classify(String(p), quotedAt ? quotedAt[idx]! : false));
  // Reject prototype-pollution keys in ANY segment (bracket-quoted forms are
  // already unquoted by toPathArray, so `$['__proto__']` is caught here too).
  for (const seg of segments) {
    if (seg.kind === 'key' && isForbiddenKey(seg.key)) {
      throw new UnsupportedPathError(
        `path '${path}' contains a forbidden key '${seg.key}' (prototype-pollution vector)`
      );
    }
  }
  return segments;
}

/** The string/number key used to index a plain object/array for a singular segment. */
function segKey(seg: PathSegment): string {
  if (seg.kind === 'key') return seg.key;
  if (seg.kind === 'index') return String(seg.index);
  // Guarded by isSingularPath at the call site.
  throw new UnsupportedPathError('non-singular segment cannot be a plain key');
}

/**
 * Read the value at `path` from `obj`. Returns `undefined` when the path matches
 * nothing (a common, non-fatal case: the agent doesn't know the value yet).
 * Multiple matches collapse to an array (jsonpath-plus `wrap:false`).
 */
export function readAtPath(obj: unknown, path: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (path.length > MAX_PATH_LEN) return undefined; // DoS guard before the O(n²) parse
  try {
    return JSONPath({ path, json: obj as never, wrap: false });
  } catch {
    return undefined;
  }
}

/**
 * Guard an array index before it is used to descend into / assign onto an existing
 * array. A buyer-input field targets an EXISTING element (or, at most, appends the
 * single next one), so `index` must be `<= arr.length`. This blocks a merchant path
 * like `$.line_items[1000000000].id`, where `arr[1e9]=v` + `JSON.stringify` would
 * balloon into ~1e9 nulls (an OOM/DoS) — a far-out sparse element is never created.
 */
function assertArrayIndexInBounds(index: number, length: number, path: string): void {
  if (index > length) {
    throw new UnsupportedPathError(
      `array index ${index} is out of bounds (length ${length}) in '${path}' — a buyer-input ` +
        `field must target an existing array element, not a far-out sparse index`
    );
  }
}

/** Assign a leaf/intermediate key defensively — never touch the prototype chain. */
function safeAssign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (isForbiddenKey(key)) {
    // Unreachable given toSegments already rejects forbidden keys; kept as a
    // hard second line of defence so no future caller can pollute via writeAtPath.
    throw new UnsupportedPathError(`refusing to write forbidden key '${key}'`);
  }
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Write `value` at `path` into `obj`, mutating it in place.
 *
 * ONLY singular, writable, pollution-safe paths are accepted (child key,
 * non-negative index, bracket-quoted key): the path is walked, CREATING
 * intermediate objects/arrays as needed, then the leaf is set with a guarded
 * assignment. A wildcard/descendant/filter/negative-index path — which cannot
 * name a single write location — and any forbidden key are rejected with
 * {@link UnsupportedPathError} (the fan-out / prototype-pollution vectors are
 * removed entirely; there is no non-singular resolution branch to reach).
 */
export function writeAtPath(obj: Record<string, unknown> | unknown[], path: string, value: unknown): void {
  const segments = toSegments(path); // rejects forbidden keys up front
  if (segments.length === 0) {
    throw new UnsupportedPathError(`cannot write to the document root ('${path}')`);
  }
  if (!segments.every(isWritableSingularSegment)) {
    throw new UnsupportedPathError(
      `path '${path}' is not a singular writable location (wildcard/descendant/filter/negative index are not permitted for a single-field write)`
    );
  }

  // Walk (creating intermediates), then set the leaf — all via guarded assigns.
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    // Bound an index BEFORE using it to descend into an existing array.
    if (seg.kind === 'index' && Array.isArray(cur)) {
      assertArrayIndexInBounds(seg.index, cur.length, path);
    }
    const key = segKey(seg);
    const nextSeg = segments[i + 1]!;
    const child = cur[key];
    if (child === null || child === undefined || typeof child !== 'object') {
      safeAssign(cur, key, nextSeg.kind === 'index' ? [] : {});
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1]!;
  // Bound the leaf index too — `arr[1e9] = value` is the direct sparse-array blowup.
  if (leaf.kind === 'index' && Array.isArray(cur)) {
    assertArrayIndexInBounds(leaf.index, cur.length, path);
  }
  safeAssign(cur, segKey(leaf), value);
}
