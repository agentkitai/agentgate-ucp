import type { ParkedSessionStore } from '../store/parked';
import type { MerchantClient } from '../merchant/client';

/**
 * AgentGate decision-webhook receiver: verify the HMAC signature
 * (X-AgentGate-Signature), normalize `data.request.params` (string|object),
 * correlate on request.id, and resume the parked completion — replay
 * complete_checkout with the ORIGINAL idempotency-key (at-least-once safe via
 * the merchant's idempotency + the parked `status` guard).
 *
 * TODO(#10): implement HMAC verify + status-guarded resume.
 */
export interface WebhookDeps {
  store: ParkedSessionStore;
  merchant: MerchantClient;
  webhookSecret: string | undefined;
}

export function handleDecisionWebhook(
  _deps: WebhookDeps,
  _rawBody: string,
  _signature: string | undefined
): Promise<void> {
  throw new Error('handleDecisionWebhook not implemented (task #10)');
}
