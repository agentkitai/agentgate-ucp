import { describe, it, expect } from 'vitest';
import { flattenCheckout, UngateableTotalError } from '../src/gate/flatten.js';
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

  it('FAILS CLOSED (throws) when no type:total entry is present — never defaults to 0', () => {
    // A completable checkout with no grand total must not be gated as $0 (finding C2).
    expect(() => flattenCheckout({ id: 'co_2', status: 'ready_for_complete' })).toThrow(
      UngateableTotalError
    );
    expect(() => flattenCheckout({ id: 'co_2b', status: 'ready_for_complete', totals: [] })).toThrow(
      UngateableTotalError
    );
    // Component-only totals (no consolidated 'total' line) also fail closed.
    expect(() =>
      flattenCheckout({ id: 'co_2c', status: 'ready_for_complete', totals: [{ type: 'items', amount: 999900 }] })
    ).toThrow(UngateableTotalError);
  });

  it('FAILS CLOSED on a non-numeric / negative amount (finding H5)', () => {
    const mk = (amount: unknown): Checkout =>
      ({ id: 'co_x', status: 'ready_for_complete', totals: [{ type: 'total', amount }] }) as Checkout;
    expect(() => flattenCheckout(mk('50000'))).toThrow(UngateableTotalError); // string
    expect(() => flattenCheckout(mk(-1))).toThrow(UngateableTotalError); // negative
    expect(() => flattenCheckout(mk(NaN))).toThrow(UngateableTotalError); // NaN
    expect(() => flattenCheckout(mk(Infinity))).toThrow(UngateableTotalError); // non-finite
  });

  it('skips line items without a string id (but still counts them)', () => {
    const checkout: Checkout = {
      id: 'co_3',
      status: 'ready_for_complete',
      totals: [{ type: 'total', amount: 100 }],
      line_items: [{ id: 'li_1' }, { sku: 'no-id' }, { id: 42 }],
    };
    const facts = flattenCheckout(checkout);
    expect(facts.line_item_ids).toEqual(['li_1']);
    expect(facts.line_count).toBe(3);
  });
});
