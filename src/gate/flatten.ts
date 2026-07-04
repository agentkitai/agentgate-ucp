import type { Checkout, CheckoutFacts } from '../types.js';

/**
 * Flatten a merchant Checkout into matcher-friendly facts for AgentGate policy
 * evaluation. Gate on the MERCHANT's totals (it recomputes them server-side),
 * not the agent-supplied object — otherwise an agent could under-report to dodge
 * the gate. Amounts are minor units; the grand total is the `type === 'total'` entry.
 */
export function flattenCheckout(checkout: Checkout): CheckoutFacts {
  const totalEntry = (checkout.totals ?? []).find((t) => t.type === 'total');
  const items = checkout.line_items ?? [];
  const lineItemIds = items
    .map((item) => item['id'])
    .filter((id): id is string => typeof id === 'string');
  return {
    totals_total_minor: totalEntry?.amount ?? 0,
    currency: checkout.currency,
    line_count: items.length,
    line_item_ids: lineItemIds,
  };
}
