/**
 * Orchestrate a TYPED per-checkout form handoff for a `requires_buyer_input`
 * escalation:
 *
 *   deref → per-message resolved field schema → compose ONE typed intake schema
 *   `{type:"object", properties:{<fieldKey>:<realFieldSchema>}, required:[…]}`
 *   → register it as `ucp-buyer-input-<checkoutId>` (idempotent) → create a
 *   prefilled submission → resume URL + fieldKey↔JSONPath map.
 *
 * fieldKey is a form-safe alias of the message's JSONPath (`$.buyer.phone_number`
 * → `buyer__phone_number`); the returned {@link FieldMap} lets the answer-back
 * webhook write each answer back at its real JSONPath.
 */
import { createHash } from 'node:crypto';

import type { FieldMap } from '../store/form-pending.js';
import type { JSONSchema } from '../schema/json-schema.js';
import { resolveFieldSchemaAtPath } from '../schema/deref.js';
import {
  assertWritableSingularPath,
  readAtPath,
  toSegments,
  UnsupportedPathError,
} from '../schema/jsonpath.js';
import type { Checkout } from '../types.js';
import type { BuyerInputMessage } from './detect.js';
import type { FormBridgeClient, FormBridgeActor } from '../formbridge/client.js';

/**
 * Build the human-facing resume URL: the FormBridge form-RENDERER page (a real
 * form), NOT the JSON resume API. `formbridgePublicUrl` must therefore be the
 * form host (the form-renderer / demo app), distinct from the API `FORMBRIDGE_URL`.
 */
export function resumeUrlForToken(formbridgePublicUrl: string, resumeToken: string): string {
  const base = formbridgePublicUrl.replace(/\/+$/, '');
  return `${base}/resume?token=${encodeURIComponent(resumeToken)}`;
}

/** Raised when a buyer-input escalation cannot be turned into a usable typed form. */
export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffError';
  }
}

export interface BuildIntakeOptions {
  checkout: Checkout;
  messages: BuyerInputMessage[];
  fbClient: FormBridgeClient;
  /** Public FormBridge URL the human's resume link points at. */
  formbridgePublicUrl: string;
  /** Adapter webhook URL FormBridge POSTs the completed submission to. */
  adapterWebhookUrl: string;
  /** Buying-agent id (submission actor + evidence attribution). */
  agentId: string;
}

export interface HandoffResult {
  intakeId: string;
  submissionId: string;
  resumeToken: string;
  resumeUrl: string;
  fieldMap: FieldMap;
  fieldKeys: string[];
  /** The composed, TYPED intake schema (proof it is not an additionalProperties blob). */
  schema: JSONSchema;
}

/**
 * Turn a JSONPath into a form-safe, unique field key, joining segments with `__`
 * (e.g. `$.buyer.phone_number` → `buyer__phone_number`, `$.line_items[0].id` →
 * `line_items__i0__id`). The fieldKey↔JSONPath map preserves the real path.
 */
function fieldKeyForPath(path: string, taken: Set<string>): string {
  const parts = toSegments(path).map((seg) => {
    if (seg.kind === 'key') return seg.key.replace(/[^A-Za-z0-9_]/g, '_');
    if (seg.kind === 'index') return `i${seg.index}`;
    if (seg.kind === 'wildcard') return 'all';
    return 'match';
  });
  const base = parts.join('__') || 'field';
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  taken.add(key);
  return key;
}

/**
 * Build + register the typed intake and open a prefilled submission. Throws
 * {@link HandoffError} if NOT ONE message can be mapped to a real field schema
 * (the caller then falls back to the raw escalation).
 */
export async function buildBuyerInputIntake(opts: BuildIntakeOptions): Promise<HandoffResult> {
  const { checkout, messages, fbClient, agentId } = opts;

  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  const fieldMap: FieldMap = {};
  const initialFields: Record<string, unknown> = {};
  const taken = new Set<string>();

  for (const msg of messages) {
    let fieldSchema: JSONSchema;
    try {
      // A buyer-input field must map to exactly ONE writable, pollution-safe
      // location. Reject wildcard/descendant/filter/negative-index/forbidden-key
      // paths BEFORE resolving a schema (a wildcard would otherwise resolve to the
      // array-element schema and then fan out/clobber on write-back).
      assertWritableSingularPath(msg.path);
      fieldSchema = await resolveFieldSchemaAtPath(msg.path);
    } catch (err) {
      if (err instanceof UnsupportedPathError) {
        // Documented fallback: skip a non-singular / un-mappable path (logged),
        // never crash. If every message is skipped the caller raw-escalates.
        console.warn(
          `[agentgate-ucp] buyer-input path '${msg.path}' is not a mappable single-field path: ${err.message}`
        );
        continue;
      }
      throw err;
    }

    const key = fieldKeyForPath(msg.path, taken);
    // Carry the merchant's human-readable prompt into the field description.
    if (msg.content && !fieldSchema.description) fieldSchema.description = msg.content;
    properties[key] = fieldSchema;
    required.push(key);
    fieldMap[key] = msg.path;

    // Prefill any value the agent already knows at this (now singular) path.
    const known = readAtPath(checkout, msg.path);
    if (known !== undefined) initialFields[key] = known;
  }

  if (required.length === 0) {
    throw new HandoffError('no buyer-input message mapped to a resolvable UCP field schema');
  }

  const schema: JSONSchema = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };

  const checkoutId = String(checkout.id);
  const intakeId = `ucp-buyer-input-${checkoutId}`;

  await fbClient.registerIntake({
    id: intakeId,
    version: '1.0.0',
    name: `UCP buyer input for ${checkoutId}`,
    description: 'Fields the merchant needs the buyer to supply to complete this checkout.',
    schema,
    destination: { kind: 'webhook', url: opts.adapterWebhookUrl },
    // Deliberately NO approvalGates — an ungated submit fires the destination webhook.
  });

  const actor: FormBridgeActor = { kind: 'agent', id: agentId };
  // A stable idempotency-key (checkout + the sorted field set) so FormBridge itself
  // dedups repeated createSubmission calls for the same still-pending checkout.
  const submissionIdempotencyKey = createHash('sha256')
    .update(`${checkoutId}\n${[...required].sort().join('\n')}`)
    .digest('hex');
  const created = await fbClient.createSubmission(intakeId, {
    actor,
    initialFields,
    idempotencyKey: submissionIdempotencyKey,
  });

  const resumeUrl = resumeUrlForToken(opts.formbridgePublicUrl, created.resumeToken);

  return {
    intakeId,
    submissionId: created.submissionId,
    resumeToken: created.resumeToken,
    resumeUrl,
    fieldMap,
    fieldKeys: required,
    schema,
  };
}
