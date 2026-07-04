/**
 * Detect a UCP `requires_buyer_input` escalation on a merchant Checkout.
 *
 * A merchant signals "I need the human to supply a field before I can finish"
 * with `status: "requires_escalation"` and one or more messages of
 * `severity: "requires_buyer_input"`, each carrying a `path` (RFC-9535 JSONPath)
 * to the missing/invalid checkout field. We surface exactly those messages (only
 * the ones with a usable `path`) so the handoff can build a TYPED form field per
 * message from the resolved UCP field schema.
 */
import type { Checkout, CheckoutMessage } from '../types.js';

/** A buyer-input message with a guaranteed field `path`. */
export interface BuyerInputMessage {
  /** RFC-9535 JSONPath to the checkout field the human must supply. */
  path: string;
  code?: string | undefined;
  content?: string | undefined;
}

/** Is this message a buyer-input request pointing at a concrete field path? */
function isBuyerInput(msg: CheckoutMessage): boolean {
  return msg.severity === 'requires_buyer_input' && typeof msg.path === 'string' && msg.path.length > 0;
}

/**
 * Return the `requires_buyer_input` messages that address a concrete field path.
 *
 * Gated on `status === 'requires_escalation'` (the UCP contract for a message
 * that blocks completion); a checkout in any other status yields `[]` even if a
 * stray buyer-input message is present, so passthrough results in normal states
 * are never diverted into a handoff.
 */
export function detectBuyerInput(checkout: Checkout): BuyerInputMessage[] {
  if (checkout.status !== 'requires_escalation') return [];
  const messages = checkout.messages ?? [];
  return messages.filter(isBuyerInput).map((m) => ({
    path: m.path as string,
    code: m.code,
    content: m.content,
  }));
}
