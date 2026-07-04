import { AgentGateClient } from '@agentkitai/agentgate-sdk';

import type { CheckoutFacts } from '../types.js';

/**
 * The gate decision for a `complete_checkout`, derived from AgentGate's static
 * spend policy. `approved` → forward to the merchant; `denied`/`pending` → return
 * a UCP escalation (the buyer resolves it at `continueUrl(approvalId)`).
 */
export type GateDecision =
  | { status: 'approved' }
  | { status: 'denied'; reason: string; approvalId: string }
  | { status: 'pending'; approvalId: string };

/** Correlation context threaded from the MCP call into the AgentGate request. */
export interface GateContext {
  checkoutId: string;
  /** The UCP complete idempotency-key (generated when the agent omits one). */
  idempotencyKey: string;
  agentId?: string | undefined;
  mcpSessionId?: string | undefined;
}

/**
 * The gate seam the `complete_checkout` path depends on. `PolicyGate` is the
 * real AgentGate-backed implementation; tests inject a stub with the same shape.
 */
export interface Gate {
  evaluate(facts: CheckoutFacts, ctx: GateContext): Promise<GateDecision>;
  /** The AgentGate approval page a buyer follows to resolve an escalation. */
  continueUrl(requestId: string): string;
}

export interface PolicyGateOptions {
  baseUrl: string;
  apiKey: string;
}

/**
 * Evaluate a checkout against AgentGate spend policy via the SDK's `request()`
 * (Path A → POST /api/requests, which runs the STATIC policy engine). We do NOT
 * use `/api/mcp/authorize` — that path is override-only and ignores spend policy.
 *
 * `client.request()` returns an `ApprovalRequest` whose `status` is resolved
 * synchronously by the server-side policy engine: `approved` (a rule
 * auto-approved), `denied` (auto-denied), or `pending` (routed to a human /
 * no matching rule). We map that onto a UCP-shaped {@link GateDecision}.
 */
export class PolicyGate implements Gate {
  private readonly client: AgentGateClient;
  private readonly baseUrl: string;

  constructor(opts: PolicyGateOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.client = new AgentGateClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
  }

  async evaluate(facts: CheckoutFacts, ctx: GateContext): Promise<GateDecision> {
    const req = await this.client.request({
      action: 'ucp.complete_checkout',
      params: {
        checkout: {
          totals_total_minor: facts.totals_total_minor,
          currency: facts.currency,
          line_count: facts.line_count,
          line_item_ids: facts.line_item_ids,
        },
        checkout_id: ctx.checkoutId,
        idempotency_key: ctx.idempotencyKey,
      },
      context: {
        agentId: ctx.agentId,
        mcp_session_id: ctx.mcpSessionId,
      },
      urgency: 'normal',
    });

    switch (req.status) {
      case 'approved':
        return { status: 'approved' };
      case 'denied':
        return {
          status: 'denied',
          reason: req.decisionReason ?? 'Denied by AgentGate spend policy.',
          approvalId: req.id,
        };
      // `pending` (routed to human) and `expired` both mean "not approved, do not
      // complete" — surface an escalation the buyer can resolve. Webhook-driven
      // resume of a later approval is task #10.
      case 'pending':
      case 'expired':
      default:
        return { status: 'pending', approvalId: req.id };
    }
  }

  continueUrl(requestId: string): string {
    return `${this.baseUrl}/requests/${requestId}`;
  }
}
