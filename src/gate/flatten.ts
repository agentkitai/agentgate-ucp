import type { Checkout, CheckoutFacts } from '../types.js';

/** Thrown when a merchant Checkout carries no gate-able grand total (fail closed). */
export class UngateableTotalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UngateableTotalError';
  }
}

/**
 * Flatten a merchant Checkout into matcher-friendly facts for AgentGate policy
 * evaluation. Gate on the MERCHANT's totals (it recomputes them server-side),
 * not the agent-supplied object — otherwise an agent could under-report to dodge
 * the gate. Amounts are minor units; the grand total is the `type === 'total'` entry.
 *
 * FAILS CLOSED on the amount: a missing `type:'total'` line — or a non-finite,
 * negative, or non-numeric amount (the merchant response is untyped JSON, so
 * `amount` is whatever bytes arrived) — is NOT coerced to 0. Defaulting to 0 let a
 * merchant that omits the total (or serialises it as a string) sail under any
 * upper-bound spend cap, so we throw and the caller refuses the completion instead
 * of gating on a phantom $0.
 */
export function flattenCheckout(checkout: Checkout): CheckoutFacts {
  const totalEntry = (checkout.totals ?? []).find((t) => t.type === 'total');
  const amount = totalEntry?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new UngateableTotalError(
      `checkout ${String(checkout.id)} has no valid grand-total line (type:'total' with a finite ` +
        `non-negative amount); got ${JSON.stringify(amount)} — refusing to gate an unverifiable amount`
    );
  }
  const items = checkout.line_items ?? [];
  const lineItemIds = items
    .map((item) => item['id'])
    .filter((id): id is string => typeof id === 'string');
  return {
    totals_total_minor: amount,
    currency: checkout.currency,
    line_count: items.length,
    line_item_ids: lineItemIds,
  };
}
