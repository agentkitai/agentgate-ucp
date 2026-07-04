/**
 * FormBridge answer-back webhook: the human filled the typed form, FormBridge
 * POSTs the completed submission to `<adapter>/formbridge/webhook`, and we close
 * the loop.
 *
 * FormBridge signs the RAW body as `sha256=<HMAC-SHA256(rawBody, secret)>` in
 * `X-FormBridge-Signature` (see webhook-manager.ts `buildHeaders`); we verify it
 * timing-safe (mirroring the AgentGate receiver). Then, keyed on the delivered
 * `submissionId`:
 *
 *   1. status-guard against duplicate (at-least-once) deliveries;
 *   2. GET the authoritative checkout from the merchant;
 *   3. reconstruct a MERCHANT-SHAPED update body — the FULL `line_items` from the
 *      GET + `currency` + the buyer object — and `writeAtPath` each answer at its
 *      real JSONPath (the sample merchant's `update_checkout` recomputes totals
 *      and REPLACES `line_items`/`buyer`, so it needs the whole array);
 *   4. `update_checkout`;
 *   5. RE-DRIVE `complete_checkout` through the spend gate with the STORED payment
 *      payload + pinned idempotency-key (skipped for a passthrough handoff with no
 *      stored payload);
 *   6. mark the row resolved + emit `ucp.buyer_input.collected` / `ucp.order.redriven`.
 *
 * NEVER throws — every failure path returns a {@link AnswerBackResult}; the HTTP
 * layer maps the outcome onto a status code and always acks (a business error is
 * logged, not retried forever).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Gate } from '../gate/agentgate';
import { gateCompleteCheckout } from '../gate/complete';
import { detectBuyerInput } from './detect';
import type { HandoffDeps } from './run';
import { MerchantClient, MerchantError } from '../merchant/client';
import type { EvidenceRecorder } from '../observability/agentlens';
import { recordGateEvent } from '../observability/agentlens';
import { writeAtPath } from '../schema/jsonpath';
import type { FormPendingStatus, FormPendingStore } from '../store/form-pending';
import type { ParkedSessionStore } from '../store/parked';
import type { Checkout } from '../types';

const EVIDENCE_SOURCE = 'agentgate-ucp';

export interface AnswerBackDeps {
  store: FormPendingStore;
  merchant: MerchantClient;
  gate: Gate;
  webhookSecret: string | undefined;
  /**
   * Parked-session store, threaded into the re-drive so a spend-`pending` decision
   * PARKS a row the AgentGate decision webhook can later resume — otherwise the
   * human's spend approval would find no row and the order could never be placed.
   */
  parked?: ParkedSessionStore | undefined;
  /**
   * FormBridge handoff bundle, threaded into the re-drive so a RENEWED
   * `requires_buyer_input` escalation on the re-driven completion mints a NEW form +
   * form-pending row (the next round) instead of being mislabelled `resolved` and
   * dropped. Absent ⇒ a renewed request cannot be turned into a form, so the row is
   * left recoverable (never `resolved`).
   */
  handoff?: HandoffDeps | undefined;
  recorder?: EvidenceRecorder | undefined;
}

export type AnswerBackOutcome = 'rejected' | 'ignored' | 'resolved' | 'denied' | 'error';

export interface AnswerBackResult {
  outcome: AnswerBackOutcome;
  reason?: string;
  /** True when the stored completion was re-driven through the gate. */
  redriven?: boolean;
  /**
   * True when the failure is transient (merchant/re-drive error): the route maps
   * it to a non-2xx so FormBridge RETRIES the delivery and the order is not lost.
   */
  retryable?: boolean;
}

/**
 * Classify a NON-error re-drive result into the terminal form-pending status.
 * A policy DENIAL is terminal with NO order placed (must NOT be 'resolved'); an
 * approved/parked completion is 'resolved' (the form's job is done — a parked
 * spend-approval is then owned by the parked-session store).
 */
function redriveRowStatus(sc: Checkout | undefined): FormPendingStatus {
  const code = sc?.messages?.[0]?.code;
  if (sc?.status === 'requires_escalation' && code === 'policy_denied') return 'denied';
  return 'resolved';
}

/** Constant-time compare of `sha256=<hex>` against the recomputed HMAC. */
function signatureMatches(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Best-effort order id from a completed merchant Checkout (top-level or nested). */
function extractOrderId(sc: unknown): string | undefined {
  if (!sc || typeof sc !== 'object') return undefined;
  const co = sc as Checkout;
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
 * Reconstruct a merchant-shaped `update_checkout` body from the authoritative
 * GET. The sample merchant REPLACES line_items + buyer wholesale and recomputes
 * totals, so we resend the FULL authoritative line_items + currency and seed the
 * buyer object (so patching one field doesn't wipe the others).
 *
 * The merchant's `ExtendedCheckoutUpdateRequestSchema` also REQUIRES `id`,
 * `currency`, `line_items`, and a `payment` object (its sub-fields are optional,
 * so `{}` validates and the merchant merges it over the existing payment).
 */
function reconstructUpdateBody(authoritative: Checkout): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: authoritative.id,
    line_items: authoritative.line_items ?? [],
    currency: authoritative.currency,
    payment: {},
  };
  if (authoritative.buyer && typeof authoritative.buyer === 'object') {
    body['buyer'] = { ...(authoritative.buyer as Record<string, unknown>) };
  }
  return body;
}

/**
 * Handle one FormBridge answer-back delivery. See the module doc for the flow.
 * NEVER throws.
 */
export async function handleAnswerBackWebhook(
  deps: AnswerBackDeps,
  rawBody: string,
  signature: string | undefined
): Promise<AnswerBackResult> {
  const { store, merchant, gate, webhookSecret, recorder, parked } = deps;

  // 1. Verify the HMAC signature — ALWAYS. This endpoint re-drives a real payment,
  //    so it fails CLOSED: no secret ⇒ no verification is possible ⇒ reject. The
  //    route itself is only registered when a secret is configured (see createApp),
  //    so in production this branch is unreachable; keeping it here guarantees the
  //    handler can NEVER accept an unsigned re-drive even if called directly.
  if (!webhookSecret || !signatureMatches(webhookSecret, rawBody, signature)) {
    return { outcome: 'rejected', reason: 'invalid or missing X-FormBridge-Signature' };
  }

  // 2. Parse the delivery payload. Malformed bodies are permanent (not retryable).
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { outcome: 'error', retryable: false, reason: 'body is not valid JSON' };
  }
  if (!payload || typeof payload !== 'object') {
    return { outcome: 'error', retryable: false, reason: 'malformed webhook payload' };
  }
  const p = payload as { submissionId?: unknown; fields?: unknown };
  if (typeof p.submissionId !== 'string' || p.submissionId.length === 0) {
    return { outcome: 'error', retryable: false, reason: 'missing submissionId' };
  }
  const fields =
    p.fields && typeof p.fields === 'object' ? (p.fields as Record<string, unknown>) : {};

  // 3. ATOMICALLY claim the row (pending/error → processing). Of N concurrent
  //    deliveries exactly one wins; terminal (resolved/denied) or in-flight
  //    (processing) rows are not claimable, so duplicates are ignored.
  if (!store.claim(p.submissionId)) {
    const existing = store.get(p.submissionId);
    if (!existing) return { outcome: 'ignored', reason: 'no parked form for submission id' };
    return { outcome: 'ignored', reason: `not claimable (status=${existing.status})` };
  }
  const row = store.get(p.submissionId);
  if (!row) return { outcome: 'ignored', reason: 'no parked form for submission id' };

  const sessionId = `ucp_${row.checkoutId}`;
  const agentId = row.agentId ?? 'ucp-anonymous';
  const metadata: Record<string, unknown> = {
    checkoutId: row.checkoutId,
    submissionId: row.submissionId,
    idempotencyKey: row.idempotencyKey,
    source: EVIDENCE_SOURCE,
  };
  const headers = { ucpAgent: row.ucpAgent };

  try {
    // 2/3. Authoritative checkout + merchant-shaped update body with answers merged.
    const authoritative = await merchant.getCheckout(row.checkoutId, headers);
    const updateBody = reconstructUpdateBody(authoritative);

    const applied: string[] = [];
    for (const [fieldKey, value] of Object.entries(fields)) {
      const path = row.fieldMap[fieldKey];
      if (!path) continue; // an answer for a field we didn't map — ignore it
      writeAtPath(updateBody, path, value);
      applied.push(fieldKey);
    }

    // 4. Push the human's answers to the merchant. No idempotency-key: it is a
    //    distinct operation from the pinned completion (reusing it would 409 on
    //    the merchant's per-key request-hash check).
    await merchant.updateCheckout(row.checkoutId, updateBody, headers);

    recordGateEvent(recorder, {
      sessionId,
      agentId,
      type: 'ucp.buyer_input.collected',
      data: { submissionId: row.submissionId, fields: applied, paths: applied.map((k) => row.fieldMap[k]) },
      metadata,
    });

    // 5. Re-drive completion through the spend gate with the ORIGINAL payment
    //    payload + pinned idempotency-key. The gate re-GETs the authoritative
    //    checkout, so the buyer's answer (which may change the merchant's
    //    recomputed total) is RE-EVALUATED by policy — a denial here places NO
    //    order. The parked store is threaded so a spend-`pending` decision parks a
    //    row for the decision webhook. The handoff deps are threaded (forceFresh) so
    //    a RENEWED buyer-input escalation mints a NEW form + row (the next round).
    if (row.paymentPayload === null || row.paymentPayload === undefined) {
      // Passthrough handoff (no completion to re-drive): the update itself resolves it.
      store.markStatus(row.submissionId, 'resolved');
      recordGateEvent(recorder, {
        sessionId,
        agentId,
        type: 'ucp.order.redriven',
        data: { submissionId: row.submissionId, redriven: false },
        metadata,
      });
      return { outcome: 'resolved', redriven: false };
    }

    const meta: Record<string, unknown> = { 'idempotency-key': row.idempotencyKey };
    if (row.ucpAgent) meta['ucp-agent'] = row.ucpAgent;
    // Row count before the re-drive — a renewed buyer-input parks a NEW row, so an
    // increase (robust against created_at ties) means a fresh round was spawned.
    const roundsBefore = store.countByCheckoutId(row.checkoutId);
    const result: CallToolResult = await gateCompleteCheckout(
      merchant,
      gate,
      { meta, id: row.checkoutId, checkout: row.paymentPayload },
      { forceFreshHandoff: true },
      parked,
      recorder,
      deps.handoff
    );
    const sc = result.structuredContent as Checkout | undefined;
    const orderId = extractOrderId(sc);

    // A transient merchant failure on the re-driven completion → keep the row
    // re-claimable ('error') and signal a retry so the order is never dropped.
    if (result.isError) {
      store.markStatus(row.submissionId, 'error');
      recordGateEvent(recorder, {
        sessionId,
        agentId,
        type: 'ucp.order.redriven',
        data: { submissionId: row.submissionId, redriven: true, status: 'error' },
        metadata,
      });
      return {
        outcome: 'error',
        retryable: true,
        redriven: true,
        reason: `re-driven completion failed: ${extractText(result)}`,
      };
    }

    // 6a. RENEWED buyer-input: the re-driven completion asked for ANOTHER field.
    //     With handoff configured, the re-drive already minted a NEW form + a NEW
    //     form-pending row (forceFresh) — detectable as a fresh row for this checkout
    //     with a different submission id. THIS (round-1) form was answered, so mark
    //     it resolved; the new row now owns the next answer-back. WITHOUT handoff (or
    //     if the new field's path was unmappable) no new row exists — do NOT mark
    //     resolved (that would silently drop the new request); leave the row
    //     recoverable ('error') and ack so FormBridge stops retrying this delivery.
    if (sc && detectBuyerInput(sc).length > 0) {
      const spawnedNewRound = store.countByCheckoutId(row.checkoutId) > roundsBefore;
      const latest = store.getByCheckoutId(row.checkoutId);
      if (spawnedNewRound) {
        store.markStatus(row.submissionId, 'resolved');
        recordGateEvent(recorder, {
          sessionId,
          agentId,
          type: 'ucp.order.redriven',
          data: {
            submissionId: row.submissionId,
            redriven: true,
            status: sc.status,
            renewedBuyerInput: latest?.submissionId,
          },
          metadata,
        });
        return { outcome: 'resolved', redriven: true };
      }
      store.markStatus(row.submissionId, 'error');
      recordGateEvent(recorder, {
        sessionId,
        agentId,
        type: 'ucp.order.redriven',
        data: { submissionId: row.submissionId, redriven: true, status: 'error', renewedBuyerInput: true },
        metadata,
      });
      return {
        outcome: 'error',
        retryable: false,
        redriven: true,
        reason: 'renewed buyer-input on re-drive but no form handoff configured',
      };
    }

    // 6b. Terminal status from the re-drive: 'denied' (policy denied, no order) or
    //     'resolved' (placed / parked for spend approval). Never mislabel a denial.
    const finalStatus = redriveRowStatus(sc);
    store.markStatus(row.submissionId, finalStatus);
    recordGateEvent(recorder, {
      sessionId,
      agentId,
      type: 'ucp.order.redriven',
      data: { submissionId: row.submissionId, redriven: true, status: sc?.status, orderId },
      metadata,
    });

    return { outcome: finalStatus === 'denied' ? 'denied' : 'resolved', redriven: true };
  } catch (err) {
    // Transient merchant failure (GET/update threw) → re-claimable + retry.
    store.markStatus(row.submissionId, 'error');
    const reason =
      err instanceof MerchantError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`[agentgate-ucp] answer-back failed for submission ${row.submissionId}: ${reason}`);
    return { outcome: 'error', retryable: true, reason };
  }
}

/** Best-effort human-readable text from a CallToolResult (for error reasons). */
function extractText(result: CallToolResult): string {
  const first = result.content?.[0];
  if (first && typeof first === 'object' && 'text' in first) {
    const t = (first as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return 'unknown error';
}
