import type { CheckoutFacts } from '../types';

/**
 * Thin wrapper over the AgentGate SDK. Evaluate a checkout against spend policy
 * via `client.request()` (Path A — the static policy engine; NOT
 * `/api/mcp/authorize`, which is override-only and ignores spend policy).
 *
 * TODO(#9): wire AgentGateClient.request()/waitForDecision(); carry the UCP
 * idempotency-key inside params for webhook-driven replay.
 */
export type GateDecision =
  | { status: 'approved' }
  | { status: 'denied'; reason: string }
  | { status: 'pending'; approvalId: string };

export function evaluateCheckout(_facts: CheckoutFacts): Promise<GateDecision> {
  throw new Error('evaluateCheckout not implemented (task #9)');
}
