/**
 * AgentGate decision-webhook receiver: verify the HMAC signature
 * (X-AgentGate-Signature), normalize `data.request.params` (string|object),
 * correlate on request.id, and resume the parked completion — replay
 * complete_checkout with the ORIGINAL idempotency-key (at-least-once safe via
 * the merchant's idempotency + the parked `status` guard).
 *
 * AgentGate signs the raw JSON body as `HMAC-SHA256(rawBody, secret)` hex-encoded
 * with NO prefix (see agentgate/packages/server/src/lib/webhook.ts `signPayload`),
 * and delivers `JSON.stringify({ event, data, timestamp })` where
 * `event ∈ {'request.approved','request.denied'}` and `data.request` is the
 * decided request snapshot.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { isRetryableMerchantError } from '../merchant/client.js';
import type { MerchantClient } from '../merchant/client.js';
import type { EvidenceRecorder } from '../observability/agentlens.js';
import { recordGateEvent } from '../observability/agentlens.js';
import type { Checkout } from '../types.js';

import type { ParkedSessionStore } from '../store/parked.js';

export interface WebhookDeps {
  store: ParkedSessionStore;
  merchant: MerchantClient;
  webhookSecret: string | undefined;
  /** Optional AgentLens recorder — resume events chain onto the checkout's session. */
  recorder?: EvidenceRecorder | undefined;
}

/** Marks every evidence event as originating from this adapter (the source of truth). */
const EVIDENCE_SOURCE = 'agentgate-ucp';

/** Best-effort order id from a completed merchant Checkout (top-level or nested). */
function extractOrderId(checkout: unknown): string | undefined {
  if (!checkout || typeof checkout !== 'object') return undefined;
  const co = checkout as Checkout;
  const top = co['order_id'];
  if (typeof top === 'string' && top.length > 0) return top;
  const order = co.order;
  if (order && typeof order === 'object') {
    const oid = (order as Record<string, unknown>)['id'];
    if (typeof oid === 'string' && oid.length > 0) return oid;
  }
  return undefined;
}

/**
 * The outcome the HTTP layer maps onto a status code:
 *   rejected           → 401 (bad signature; do NOT process)
 *   ignored            → 200 (unknown id, or a duplicate/at-least-once replay — a no-op)
 *   approved_replayed  → 200 (order placed / re-placed idempotently)
 *   denied             → 200 (decision recorded, no order)
 *   error              → 200 (business error; ack so AgentGate stops retrying, but we log)
 */
export type WebhookOutcome =
  | 'rejected'
  | 'ignored'
  | 'approved_replayed'
  | 'denied'
  | 'error';

export interface WebhookResult {
  outcome: WebhookOutcome;
  reason?: string;
  /**
   * True when the failure is transient (the merchant replay threw): the route maps
   * it to a non-2xx so AgentGate RETRIES the delivery. The parked row is left
   * re-claimable (`error`) so the retry re-drives the completion — a mid-replay
   * merchant blip must never permanently strand a human-approved order.
   */
  retryable?: boolean;
}

/** Constant-time compare of the received signature against the recomputed HMAC hex. */
function signatureMatches(
  secret: string,
  rawBody: string,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on length mismatch; guard first (a malformed sig differs in length).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `data.request.params` may arrive as a JSON string or an already-parsed object. */
function normalizeParams(params: unknown): unknown {
  if (typeof params === 'string') {
    try {
      return JSON.parse(params);
    } catch {
      return params;
    }
  }
  return params;
}

/**
 * Handle one decision-webhook delivery. NEVER throws — every failure path returns
 * a {@link WebhookResult}. The HTTP layer decides the status code from `outcome`.
 */
export async function handleDecisionWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signature: string | undefined
): Promise<WebhookResult> {
  const { store, merchant, webhookSecret, recorder } = deps;

  // 1. Verify the HMAC signature — ALWAYS, fail CLOSED. This endpoint re-drives a
  //    real (over-policy) completion, so an unsigned or unverifiable delivery is
  //    rejected. With NO secret configured there is nothing to verify against, so we
  //    reject rather than accept: there is NO dev-mode / no-secret bypass. (The route
  //    is also only registered when a secret is set — see createApp — and config
  //    refuses to start without one; this is the innermost of those three guards.)
  if (!webhookSecret || !signatureMatches(webhookSecret, rawBody, signature)) {
    return { outcome: 'rejected', reason: 'invalid or missing X-AgentGate-Signature' };
  }

  // 2. Parse the envelope: { event, data: { request } }.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { outcome: 'error', reason: 'body is not valid JSON' };
  }
  if (!payload || typeof payload !== 'object') {
    return { outcome: 'error', reason: 'malformed webhook payload' };
  }
  const event = (payload as { event?: unknown }).event;
  const data = (payload as { data?: unknown }).data;
  if (typeof event !== 'string' || !data || typeof data !== 'object') {
    return { outcome: 'error', reason: 'missing event or data' };
  }
  const request = (data as { request?: unknown }).request;
  if (!request || typeof request !== 'object') {
    return { outcome: 'error', reason: 'missing data.request' };
  }
  const req = request as { id?: unknown; params?: unknown };
  if (typeof req.id !== 'string' || req.id.length === 0) {
    return { outcome: 'error', reason: 'missing data.request.id' };
  }
  const requestId = req.id;

  // 3. Only two events resolve a parked row; anything else is a no-op (no claim).
  if (event !== 'request.approved' && event !== 'request.denied') {
    return { outcome: 'ignored', reason: `unhandled event ${event}` };
  }

  // 4. ATOMICALLY claim the row (pending/error/stale-processing → processing). Of N
  //    concurrent or at-least-once redelivered webhooks for one requestId exactly one
  //    wins the claim; a terminal or in-flight row is not claimable. This atomic
  //    transition — NOT a read-then-check — is what prevents a double replay.
  if (!store.claim(requestId)) {
    const existing = store.get(requestId);
    if (!existing) return { outcome: 'ignored', reason: 'no parked session for request id' };
    return { outcome: 'ignored', reason: `not claimable (${existing.status})` };
  }
  const row = store.get(requestId);
  if (!row) {
    return { outcome: 'ignored', reason: 'no parked session for request id' };
  }

  // Normalize params and best-effort sanity-check correlation (never fatal).
  const params = normalizeParams(req.params);
  if (params && typeof params === 'object') {
    const p = params as Record<string, unknown>;
    if (typeof p['checkout_id'] === 'string' && p['checkout_id'] !== row.checkoutId) {
      console.warn(
        `[agentgate-ucp] webhook ${requestId}: params.checkout_id ${String(
          p['checkout_id']
        )} != parked checkout ${row.checkoutId}`
      );
    }
  }

  // Resume events chain onto the SAME per-checkout session the completion opened,
  // attributed to the original buying agent (fallback: anonymous).
  const sessionId = `ucp_${row.checkoutId}`;
  const agentId = row.agentId ?? 'ucp-anonymous';
  const evidenceMetadata: Record<string, unknown> = {
    checkoutId: row.checkoutId,
    agentgateRequestId: requestId,
    idempotencyKey: row.idempotencyKey,
    source: EVIDENCE_SOURCE,
  };

  // 5. Resolve. Replay uses the STORED snapshot + original idempotency-key so the
  //    merchant treats a retried delivery as the same request (idempotent).
  if (event === 'request.approved') {
    try {
      const completed = await merchant.completeCheckout(row.checkoutId, row.checkoutSnapshot, {
        idempotencyKey: row.idempotencyKey,
      });
      store.markStatus(requestId, 'approved_replayed', completed);
      // Evidence: the parked order was replayed + placed after human approval.
      recordGateEvent(recorder, {
        sessionId,
        agentId,
        type: 'ucp.order.replayed',
        data: {
          agentgateRequestId: requestId,
          orderId: extractOrderId(completed),
          idempotencyKey: row.idempotencyKey,
        },
        metadata: evidenceMetadata,
      });
      return { outcome: 'approved_replayed' };
    } catch (err) {
      // A TRANSIENT failure (network / 5xx / 429 / 408) → row stays re-claimable
      // (`error`) and we signal a retry (5xx) so AgentGate redelivers and the
      // human-approved order is re-driven (the pinned idempotency-key makes that safe).
      // A PERMANENT merchant 4xx (invalid payment, canceled, idempotency conflict) can
      // never succeed → mark the row TERMINAL (`failed`) so even a redelivery (e.g. a
      // lost 200 ack) can't re-execute it, and ack (retryable:false → 200) to stop the loop.
      const retryable = isRetryableMerchantError(err);
      store.markStatus(requestId, retryable ? 'error' : 'failed');
      return {
        outcome: 'error',
        retryable,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (event === 'request.denied') {
    store.markStatus(requestId, 'denied');
    // Evidence: the parked order was denied at approval time.
    recordGateEvent(recorder, {
      sessionId,
      agentId,
      type: 'ucp.order.webhook_denied',
      data: { agentgateRequestId: requestId },
      metadata: evidenceMetadata,
    });
    return { outcome: 'denied' };
  }

  // Unreachable: unhandled events are filtered before the claim (step 3). Kept as a
  // defensive terminal so the row (already claimed → processing) is never left dangling.
  store.markStatus(requestId, 'error');
  return { outcome: 'ignored', reason: `unhandled event ${String(event)}` };
}
