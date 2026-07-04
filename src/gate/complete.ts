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

import { detectBuyerInput } from '../handoff/detect';
import type { HandoffContext, HandoffDeps } from '../handoff/run';
import { maybeHandoffBuyerInput } from '../handoff/run';
import { errorResult, extractHeaders, requireId, wrapCheckout } from '../mapping';
import { MerchantClient, MerchantError } from '../merchant/client';
import type { EvidenceRecorder } from '../observability/agentlens';
import { recordGateEvent } from '../observability/agentlens';
import type { ParkedSessionStore } from '../store/parked';
import type { Checkout } from '../types';
import type { Gate } from './agentgate';
import { flattenCheckout } from './flatten';

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
    // (a) Authoritative totals from the merchant, not the agent-supplied object.
    const authoritative = await merchant.getCheckout(id, headers);
    const facts = flattenCheckout(authoritative);

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

    // (a′) If the authoritative checkout is ALREADY a buyer-input escalation AND
    // form handoff is configured, hand off immediately — there is nothing to gate
    // until the human supplies the field. Guarded on `handoff` so that with
    // FORMBRIDGE_URL unset the flow is genuinely unchanged from pre-gate-3: the
    // gate evidence is emitted, the spend gate runs, and merchant.completeCheckout
    // surfaces the escalation naturally (no short-circuit).
    if (handoff && detectBuyerInput(authoritative).length > 0) {
      const escalation = await maybeHandoffBuyerInput(authoritative, handoffCtx(), handoff, {
        forceFresh: ctx.forceFreshHandoff,
      });
      return wrapCheckout(escalation);
    }

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
        // Evidence (3a): the order is placed.
        recordGateEvent(recorder, {
          sessionId,
          agentId,
          type: 'ucp.order.placed',
          data: { orderId: extractOrderId(completed), idempotencyKey },
          metadata: metadataFor(),
        });
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
