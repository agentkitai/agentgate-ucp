import { describe, expect, it } from 'vitest';

import type { ParkedSession } from '../src/store/parked';
import { openParkedStore } from '../src/store/parked';

/** A fully-populated pending session with an object snapshot to round-trip. */
function pendingSession(overrides: Partial<ParkedSession> = {}): ParkedSession {
  return {
    approvalId: 'req_1',
    checkoutId: 'co_9',
    idempotencyKey: 'idem-abc',
    mcpSessionId: 'sess_7',
    checkoutSnapshot: { payment_data: { handler_id: 'mock_payment_handler' }, note: 'buy' },
    merchantBaseUrl: 'https://merchant.example',
    status: 'pending',
    orderResult: null,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('openParkedStore (better-sqlite3, :memory:)', () => {
  it('put → get round-trips, parsing the JSON snapshot back to an object', () => {
    const store = openParkedStore(':memory:');
    const session = pendingSession();
    store.put(session);

    const got = store.get('req_1');
    expect(got).toEqual(session);
    // The snapshot came back as a real object, not a JSON string.
    expect((got?.checkoutSnapshot as { note?: string }).note).toBe('buy');
  });

  it('get(unknown) → undefined', () => {
    const store = openParkedStore(':memory:');
    expect(store.get('nope')).toBeUndefined();
  });

  it('markStatus updates status + orderResult + updated_at (and parses orderResult back)', () => {
    const store = openParkedStore(':memory:');
    store.put(pendingSession());

    const order = { id: 'co_9', status: 'completed', order: { id: 'ord_1' } };
    store.markStatus('req_1', 'approved_replayed', order);

    const got = store.get('req_1');
    expect(got?.status).toBe('approved_replayed');
    expect(got?.orderResult).toEqual(order);
    // updated_at advanced past the seeded value; created_at is untouched.
    expect(got?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(got?.createdAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('markStatus without an orderResult clears order_result to null', () => {
    const store = openParkedStore(':memory:');
    store.put(pendingSession({ orderResult: { stale: true } }));

    store.markStatus('req_1', 'denied');
    const got = store.get('req_1');
    expect(got?.status).toBe('denied');
    expect(got?.orderResult).toBeNull();
  });

  it('put is INSERT OR REPLACE on the approval_id primary key', () => {
    const store = openParkedStore(':memory:');
    store.put(pendingSession({ status: 'pending' }));
    store.put(pendingSession({ status: 'denied', checkoutId: 'co_replaced' }));

    const got = store.get('req_1');
    expect(got?.status).toBe('denied');
    expect(got?.checkoutId).toBe('co_replaced');
  });

  it('tolerates an undefined snapshot and undefined mcpSessionId', () => {
    const store = openParkedStore(':memory:');
    store.put(pendingSession({ checkoutSnapshot: undefined, mcpSessionId: undefined }));

    const got = store.get('req_1');
    expect(got?.checkoutSnapshot).toBeNull();
    expect(got?.mcpSessionId).toBeUndefined();
  });
});
