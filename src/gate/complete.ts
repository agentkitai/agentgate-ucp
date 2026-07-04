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

import { errorResult, extractHeaders, requireId, wrapCheckout } from '../mapping';
import { MerchantClient, MerchantError } from '../merchant/client';
import type { ParkedSessionStore } from '../store/parked';
import type { Checkout } from '../types';
import type { Gate } from './agentgate';
import { flattenCheckout } from './flatten';

/** Extra correlation the server can supply (e.g. the MCP session id). */
export interface CompleteGateContext {
  mcpSessionId?: string | undefined;
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
  store?: ParkedSessionStore | undefined
): Promise<CallToolResult> {
  let id: string;
  try {
    id = requireId(args['id'], 'complete_checkout');
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  const headers = extractHeaders(args['meta']);
  const paymentPayload = args['checkout'];

  try {
    // (a) Authoritative totals from the merchant, not the agent-supplied object.
    const authoritative = await merchant.getCheckout(id, headers);
    const facts = flattenCheckout(authoritative);

    // (b) Pin an idempotency-key (generate one if the agent omitted it).
    const idempotencyKey =
      headers.idempotencyKey && headers.idempotencyKey.length > 0
        ? headers.idempotencyKey
        : randomUUID();

    // (c) Evaluate against AgentGate spend policy.
    const decision = await gate.evaluate(facts, {
      checkoutId: id,
      idempotencyKey,
      agentId: extractAgentId(args['meta']),
      mcpSessionId: ctx.mcpSessionId,
    });

    // (d) Branch on the decision.
    switch (decision.status) {
      case 'approved': {
        const completed = await merchant.completeCheckout(id, paymentPayload, {
          ...headers,
          idempotencyKey,
        });
        return wrapCheckout(completed);
      }
      case 'denied':
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
            mcpSessionId: ctx.mcpSessionId,
            checkoutSnapshot: paymentPayload,
            merchantBaseUrl: merchant.base,
            status: 'pending',
            orderResult: null,
            createdAt: now,
            updatedAt: now,
          });
        }
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
