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

import type { MerchantClient } from '../merchant/client';
import type { EvidenceRecorder } from '../observability/agentlens';
import { recordGateEvent } from '../observability/agentlens';
import type { Checkout } from '../types';

import type { ParkedSessionStore } from '../store/parked';

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

  // 1. Verify the HMAC signature. When no secret is configured we proceed in a
  //    clearly-signalled dev mode (the outcome enum lets the caller distinguish).
  if (webhookSecret) {
    if (!signatureMatches(webhookSecret, rawBody, signature)) {
      return { outcome: 'rejected', reason: 'invalid or missing X-AgentGate-Signature' };
    }
  } else {
    console.warn(
      '[agentgate-ucp] AGENTGATE_WEBHOOK_SECRET is unset — accepting webhook WITHOUT signature verification (dev mode)'
    );
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

  // 3. Correlate on request.id. No row → nothing parked here → ignore.
  const row = store.get(requestId);
  if (!row) {
    return { outcome: 'ignored', reason: 'no parked session for request id' };
  }
  // Status guard: a non-pending row was already resolved by an earlier delivery.
  // At-least-once webhooks retry, so this is the line that prevents a double replay.
  if (row.status !== 'pending') {
    return { outcome: 'ignored', reason: `already resolved (${row.status})` };
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

  // 4. Resolve. Replay uses the STORED snapshot + original idempotency-key so the
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
      store.markStatus(requestId, 'error');
      return { outcome: 'error', reason: err instanceof Error ? err.message : String(err) };
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

  // A pending row, but an event we don't act on → leave it pending, ignore.
  return { outcome: 'ignored', reason: `unhandled event ${event}` };
}
