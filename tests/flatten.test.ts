import { describe, it, expect } from 'vitest';
import { flattenCheckout } from '../src/gate/flatten.js';
import type { Checkout } from '../src/types.js';

describe('flattenCheckout', () => {
  it('extracts the grand total (type=total) in minor units', () => {
    const checkout: Checkout = {
      id: 'co_1',
      status: 'ready_for_complete',
      currency: 'USD',
      totals: [
        { type: 'items', amount: 4500 },
        { type: 'shipping', amount: 500 },
        { type: 'total', amount: 5000 },
      ],
      line_items: [{ id: 'li_1' }, { id: 'li_2' }],
    };
    const facts = flattenCheckout(checkout);
    expect(facts.totals_total_minor).toBe(5000);
    expect(facts.currency).toBe('USD');
    expect(facts.line_count).toBe(2);
    expect(facts.line_item_ids).toEqual(['li_1', 'li_2']);
  });

  it('defaults total to 0 and count to 0 when absent', () => {
    const checkout: Checkout = { id: 'co_2', status: 'incomplete' };
    const facts = flattenCheckout(checkout);
    expect(facts.totals_total_minor).toBe(0);
    expect(facts.line_count).toBe(0);
    expect(facts.line_item_ids).toEqual([]);
  });

  it('skips line items without a string id (but still counts them)', () => {
    const checkout: Checkout = {
      id: 'co_3',
      status: 'ready_for_complete',
      line_items: [{ id: 'li_1' }, { sku: 'no-id' }, { id: 42 }],
    };
    const facts = flattenCheckout(checkout);
    expect(facts.line_item_ids).toEqual(['li_1']);
    expect(facts.line_count).toBe(3);
  });
});
