/**
 * The GATE on `complete_checkout` (task #9). Unlike the other four tools (pure
 * passthrough), a completion is evaluated against AgentGate spend policy before
 * the order is placed:
 *
 *   a. GET the merchant checkout for AUTHORITATIVE totals (never trust the
 *      agent-supplied amount) and flatten it into policy facts.
 *   b. Pin an idempotency-key (generate a UUID if the agent omitted one) so the
 *      gate params, the merchant complete, and the #10 webhook replay share one.
 *   c. Ask the gate to evaluate the facts.
 *   d. Branch: approved → forward to the merchant; denied/pending → return a
 *      UCP `requires_escalation` Checkout carrying the AgentGate continue_url.
 *
 * When a {@link ParkedSessionStore} is provided (task #10), a `pending` decision
 * also PARKS a row keyed by the AgentGate request.id so the decision webhook can
 * later replay the completion. Without a store, `pending` just returns the
 * escalation (task #9 behaviour).
 */
import { randomUUID } from 'node:crypto';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { detectBuyerInput } from '../handoff/detect.js';
import type { HandoffContext, HandoffDeps } from '../handoff/run.js';
import { maybeHandoffBuyerInput } from '../handoff/run.js';
import { errorResult, extractHeaders, requireId, wrapCheckout } from '../mapping.js';
import { MerchantClient, MerchantError } from '../merchant/client.js';
import type { EvidenceRecorder } from '../observability/agentlens.js';
import { recordGateEvent } from '../observability/agentlens.js';
import type { ParkedSessionStore } from '../store/parked.js';
import type { Checkout, CheckoutFacts } from '../types.js';
import type { Gate } from './agentgate.js';
import { flattenCheckout } from './flatten.js';

/** True when two flattened fact sets are identical across EVERY gated dimension. */
function sameFacts(a: CheckoutFacts, b: CheckoutFacts): boolean {
  return (
    a.totals_total_minor === b.totals_total_minor &&
    a.currency === b.currency &&
    a.line_count === b.line_count &&
    a.line_item_ids.length === b.line_item_ids.length &&
    a.line_item_ids.every((id, i) => id === b.line_item_ids[i])
  );
}

/** Extra correlation the server can supply (e.g. the MCP session id). */
export interface CompleteGateContext {
  mcpSessionId?: string | undefined;
  /**
   * Force any buyer-input handoff on THIS completion to mint a NEW form/row instead
   * of reusing the checkout's existing one. Set by the answer-back re-drive: a
   * renewed buyer-input there is a fresh round, not the just-answered round-1 form.
   */
  forceFreshHandoff?: boolean | undefined;
}

/** Marks every evidence event as originating from this adapter (the source of truth). */
const EVIDENCE_SOURCE = 'agentgate-ucp';

/** Best-effort order id from a completed merchant Checkout (top-level or nested). */
function extractOrderId(checkout: Checkout): string | undefined {
  const top = checkout['order_id'];
  if (typeof top === 'string' && top.length > 0) return top;
  const order = checkout.order;
  if (order && typeof order === 'object') {
    const oid = (order as Record<string, unknown>)['id'];
    if (typeof oid === 'string' && oid.length > 0) return oid;
  }
  return undefined;
}

/** Best-effort agent identity from `meta['ucp-agent']` (profile URL or raw string). */
function extractAgentId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const agent = (meta as Record<string, unknown>)['ucp-agent'];
  if (typeof agent === 'string') return agent.length > 0 ? agent : undefined;
  if (agent && typeof agent === 'object') {
    const profile = (agent as Record<string, unknown>)['profile'];
    if (typeof profile === 'string' && profile.length > 0) return profile;
  }
  return undefined;
}

/** UCP escalation returned when policy DENIES the completion. Not an MCP error. */
function deniedCheckout(id: string, reason: string, continueUrl: string): Checkout {
  return {
    id,
    status: 'requires_escalation',
    continue_url: continueUrl,
    messages: [
      {
        type: 'error',
        code: 'policy_denied',
        severity: 'requires_buyer_review',
        content: reason,
      },
    ],
  };
}

/** UCP escalation returned when policy routes the completion to a human (pending). */
function pendingCheckout(id: string, approvalId: string, continueUrl: string): Checkout {
  return {
    id,
    status: 'requires_escalation',
    continue_url: continueUrl,
    messages: [
      {
        type: 'info',
        code: 'pending_approval',
        severity: 'requires_buyer_review',
        content: 'Purchase requires approval.',
      },
    ],
    approval_id: approvalId,
  };
}

/**
 * Gate + dispatch a `complete_checkout`. Never throws — merchant/argument errors
 * become `isError` results; a denied/pending policy outcome is a valid UCP
 * business result (escalation), NOT an error.
 */
export async function gateCompleteCheckout(
  merchant: MerchantClient,
  gate: Gate,
  args: Record<string, unknown>,
  ctx: CompleteGateContext = {},
  store?: ParkedSessionStore | undefined,
  recorder?: EvidenceRecorder | undefined,
  handoff?: HandoffDeps | undefined
): Promise<CallToolResult> {
  let id: string;
  try {
    id = requireId(args['id'], 'complete_checkout');
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const headers = extractHeaders(args['meta']);
  const paymentPayload = args['checkout'];

  // One AgentLens session per checkout; the buying agent (or an anonymous fallback)
  // is the actor. Every event chains onto `sessionId` server-side.
  const agentId = extractAgentId(args['meta']) ?? 'ucp-anonymous';
  const sessionId = `ucp_${id}`;
  // Pinned in step (b); the closure below reads it once it's set (never before).
  let idempotencyKey = '';
  /** Correlation stamped on every evidence event; agentgateRequestId fills in post-decision. */
  const metadataFor = (agentgateRequestId?: string): Record<string, unknown> => ({
    checkoutId: id,
    agentgateRequestId,
    idempotencyKey,
    source: EVIDENCE_SOURCE,
  });

  try {
    // (a) Authoritative checkout from the merchant, not the agent-supplied object.
    const authoritative = await merchant.getCheckout(id, headers);

    // (b) Pin an idempotency-key (generate one if the agent omitted it).
    idempotencyKey =
      headers.idempotencyKey && headers.idempotencyKey.length > 0
        ? headers.idempotencyKey
        : randomUUID();

    // Shared correlation for a possible buyer-input handoff (after GET or after complete).
    const handoffCtx = (): HandoffContext => ({
      checkoutId: id,
      merchantBaseUrl: merchant.base,
      agentId,
      ucpAgent: headers.ucpAgent,
      paymentPayload,
      idempotencyKey,
    });

    // (a′) If the authoritative checkout is ALREADY an escalation there is no
    // completable order to spend-gate — a `requires_escalation` checkout carries no
    // grand total. Surface it FAITHFULLY (hand a buyer-input off to a typed form when
    // configured, else return the raw escalation) instead of gating a phantom $0
    // total. Defaulting a missing total to 0 was the pre-fix fail-open; now flatten
    // (below) only ever runs on a genuinely completable checkout, which MUST carry a
    // real total — a completable checkout with no total is refused, not read as $0.
    if (authoritative.status === 'requires_escalation') {
      const surfaced = handoff
        ? await maybeHandoffBuyerInput(authoritative, handoffCtx(), handoff, {
            forceFresh: ctx.forceFreshHandoff,
          })
        : authoritative;
      return wrapCheckout(surfaced);
    }

    // (a) Flatten the AUTHORITATIVE (completable) totals into policy facts. Runs only
    // AFTER the escalation short-circuit above, so it always sees a completable
    // checkout — a missing/invalid grand total here is refused (fail closed), not $0.
    const facts = flattenCheckout(authoritative);

    // Evidence (1): the completion request AgentGate is about to gate.
    recordGateEvent(recorder, {
      sessionId,
      agentId,
      type: 'ucp.complete_checkout.received',
      data: {
        checkoutId: id,
        agentId,
        totals_total_minor: facts.totals_total_minor,
        currency: facts.currency,
        line_count: facts.line_count,
        line_item_ids: facts.line_item_ids,
        idempotencyKey,
      },
      metadata: metadataFor(),
    });

    // (c) Evaluate against AgentGate spend policy.
    const decision = await gate.evaluate(facts, {
      checkoutId: id,
      idempotencyKey,
      agentId: extractAgentId(args['meta']),
      mcpSessionId: ctx.mcpSessionId,
    });

    // Evidence (2): the gate decision (approvalId present for denied/pending).
    const decisionRequestId = decision.status === 'approved' ? undefined : decision.approvalId;
    recordGateEvent(recorder, {
      sessionId,
      agentId,
      type: 'ucp.gate.decision',
      data: {
        status: decision.status,
        agentgateRequestId: decisionRequestId,
        reason: decision.status === 'denied' ? decision.reason : undefined,
      },
      metadata: metadataFor(decisionRequestId),
    });

    // (d) Branch on the decision.
    switch (decision.status) {
      case 'approved': {
        // (d′) RE-BIND every gated fact to the charge. `update_checkout` is an ungated
        // passthrough, so a concurrent connection could have mutated the cart during the
        // gate's (network) evaluation window — the gate would then have approved one
        // snapshot while the merchant charges a different one. Re-fetch the authoritative
        // checkout immediately before charging and FAIL CLOSED on any drift.
        const rechecked = await merchant.getCheckout(id, headers);
        // If it slipped into an escalation during the window there is nothing to
        // complete (and no total to flatten) — surface it faithfully rather than
        // throwing an opaque error on its now-absent total.
        if (rechecked.status === 'requires_escalation') {
          const surfaced = handoff
            ? await maybeHandoffBuyerInput(rechecked, handoffCtx(), handoff, {
                forceFresh: ctx.forceFreshHandoff,
              })
            : rechecked;
          return wrapCheckout(surfaced);
        }
        // Compare ALL gated facts (total, currency, line_count, line_item_ids) — a
        // concurrent update could swap currency or line items while preserving the
        // total, charging a cart policy never evaluated. Any drift → refuse; the agent
        // re-drives against the new state (which is re-gated).
        // ponytail: this closes the eval-window race for every gated fact. The residual
        // sub-ms window between THIS get and completeCheckout can only be closed
        // merchant-side (pass the gated facts as an enforced constraint, or lock the
        // session) — out of scope for a client-side gate.
        const recheck = flattenCheckout(rechecked);
        if (!sameFacts(recheck, facts)) {
          return errorResult(
            `checkout ${id} changed after the gate approved it; refusing to complete`
          );
        }
        const completed = await merchant.completeCheckout(id, paymentPayload, {
          ...headers,
          idempotencyKey,
        });
        // The merchant may answer an approved completion with a buyer-input
        // escalation ("I still need a field from the human"). That is NOT a
        // placed order — hand it off to a typed form instead.
        if (detectBuyerInput(completed).length > 0) {
          const escalation = await maybeHandoffBuyerInput(completed, handoffCtx(), handoff, {
            forceFresh: ctx.forceFreshHandoff,
          });
          return wrapCheckout(escalation);
        }
        // The merchant may ALSO answer an approved completion with a plain
        // merchant-native escalation that is NOT buyer-input — a hold the merchant
        // needs a human to clear (e.g. an inventory review). It carries no field
        // `path`, so the buyer-input handoff above is a no-op. This is likewise NOT
        // a placed order: surface it FAITHFULLY (status/messages/continue_url are
        // already preserved by the passthrough) and record it as an escalation, NOT
        // as `ucp.order.placed` with a phantom orderId (orderId only when truly
        // completed). The spend-gate evidence above (received + decision) still
        // stands: the gate DID approve; the merchant then held the order.
        if (completed.status === 'requires_escalation') {
          recordGateEvent(recorder, {
            sessionId,
            agentId,
            type: 'ucp.order.escalated',
            data: {
              status: completed.status,
              continueUrl:
                typeof completed.continue_url === 'string' ? completed.continue_url : undefined,
              messages: completed.messages,
              idempotencyKey,
            },
            metadata: metadataFor(),
          });
          return wrapCheckout(completed);
        }
        // Evidence (3a): the order is placed — but ONLY label it placed on an EXPLICIT
        // terminal-success status. The merchant controls `status`, so a 200 body with
        // `failed`/`canceled`/an unknown status must NOT be stamped as a placed order
        // (that would forge a completed purchase into the tamper-evident timeline).
        if (completed.status === 'completed') {
          recordGateEvent(recorder, {
            sessionId,
            agentId,
            type: 'ucp.order.placed',
            data: { orderId: extractOrderId(completed), idempotencyKey },
            metadata: metadataFor(),
          });
        } else {
          recordGateEvent(recorder, {
            sessionId,
            agentId,
            type: 'ucp.order.unexpected_status',
            data: { status: completed.status, orderId: extractOrderId(completed), idempotencyKey },
            metadata: metadataFor(),
          });
        }
        return wrapCheckout(completed);
      }
      case 'denied':
        // Evidence (3b): the order is denied by policy.
        recordGateEvent(recorder, {
          sessionId,
          agentId,
          type: 'ucp.order.denied',
          data: { agentgateRequestId: decision.approvalId, reason: decision.reason },
          metadata: metadataFor(decision.approvalId),
        });
        return wrapCheckout(
          deniedCheckout(id, decision.reason, gate.continueUrl(decision.approvalId))
        );
      case 'pending': {
        // Park the session so the decision webhook can resume it later. Store the
        // authoritative payment payload + the pinned idempotency-key: the replay
        // must reproduce THIS exact completion, not re-derive it.
        if (store) {
          const now = new Date().toISOString();
          store.put({
            approvalId: decision.approvalId,
            checkoutId: id,
            idempotencyKey,
            agentId,
            mcpSessionId: ctx.mcpSessionId,
            checkoutSnapshot: paymentPayload,
            merchantBaseUrl: merchant.base,
            status: 'pending',
            orderResult: null,
            createdAt: now,
            updatedAt: now,
          });
        }
        // Evidence (3c): the order is parked for human approval.
        recordGateEvent(recorder, {
          sessionId,
          agentId,
          type: 'ucp.order.parked',
          data: {
            agentgateRequestId: decision.approvalId,
            continueUrl: gate.continueUrl(decision.approvalId),
          },
          metadata: metadataFor(decision.approvalId),
        });
        return wrapCheckout(
          pendingCheckout(id, decision.approvalId, gate.continueUrl(decision.approvalId))
        );
      }
      default: {
        const exhaustive: never = decision;
        return errorResult(`Unknown gate decision: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (err) {
    if (err instanceof MerchantError) return errorResult(err.message);
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
