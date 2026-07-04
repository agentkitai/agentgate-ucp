import { describe, expect, it } from 'vitest';

import type { FormPendingSession } from '../src/store/form-pending.js';
import { openFormPendingStore } from '../src/store/form-pending.js';
import type { ParkedSession } from '../src/store/parked.js';
import { openParkedStore } from '../src/store/parked.js';

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

function formSession(overrides: Partial<FormPendingSession> = {}): FormPendingSession {
  const now = new Date().toISOString();
  return {
    submissionId: 'sub_1',
    checkoutId: 'co_42',
    intakeId: 'ucp-buyer-input-co_42',
    merchantBaseUrl: 'https://merchant.example',
    paymentPayload: { payment_data: { handler_id: 'mock_payment_handler' } },
    idempotencyKey: 'idem-1',
    fieldMap: { buyer__phone_number: '$.buyer.phone_number' },
    resumeToken: 'rt_abc123',
    agentId: 'agent-1',
    ucpAgent: 'profile="https://platform.example/agent.json"',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('openFormPendingStore — getByCheckoutId + atomic claim', () => {
  it('round-trips a row including resumeToken and looks it up by checkoutId', () => {
    const store = openFormPendingStore(':memory:');
    store.put(formSession());

    const byId = store.get('sub_1');
    expect(byId?.resumeToken).toBe('rt_abc123');

    const byCheckout = store.getByCheckoutId('co_42');
    expect(byCheckout?.submissionId).toBe('sub_1');
    expect(byCheckout?.resumeToken).toBe('rt_abc123');
    expect(store.getByCheckoutId('nope')).toBeUndefined();
  });

  it('getByCheckoutId returns the MOST RECENT row for a checkout', () => {
    const store = openFormPendingStore(':memory:');
    store.put(formSession({ submissionId: 'sub_old', createdAt: '2020-01-01T00:00:00.000Z' }));
    store.put(formSession({ submissionId: 'sub_new', createdAt: '2026-01-01T00:00:00.000Z' }));
    expect(store.getByCheckoutId('co_42')?.submissionId).toBe('sub_new');
  });

  it('claim: two concurrent deliveries of ONE submission ⇒ exactly one wins', () => {
    const store = openFormPendingStore(':memory:');
    store.put(formSession());

    const first = store.claim('sub_1');
    const second = store.claim('sub_1');

    expect(first).toBe(true);
    expect(second).toBe(false); // already 'processing' — not re-claimable
    expect(store.get('sub_1')?.status).toBe('processing');
  });

  it('claim: an ERROR row is re-claimable (webhook retry re-drives), terminal rows are NOT', () => {
    const store = openFormPendingStore(':memory:');
    store.put(formSession());

    expect(store.claim('sub_1')).toBe(true); // pending → processing
    store.markStatus('sub_1', 'error');
    expect(store.claim('sub_1')).toBe(true); // error → processing (retry re-drives)

    store.markStatus('sub_1', 'resolved');
    expect(store.claim('sub_1')).toBe(false); // resolved is terminal

    store.markStatus('sub_1', 'denied');
    expect(store.claim('sub_1')).toBe(false); // denied is terminal
  });

  it('claim on an unknown submission id ⇒ false (no row changed)', () => {
    const store = openFormPendingStore(':memory:');
    expect(store.claim('sub_UNKNOWN')).toBe(false);
  });
});

describe('openFormPendingStore — processing lease + crash reclaim (finding A)', () => {
  it('a FRESH processing row is NOT claimable (single-processor guarantee preserved)', () => {
    const store = openFormPendingStore(':memory:');
    // Seed a row that is ALREADY processing, claimed just now (lease is live).
    store.put(formSession({ status: 'processing', claimedAt: new Date().toISOString() }));
    expect(store.claim('sub_1')).toBe(false);
    expect(store.get('sub_1')?.status).toBe('processing');
  });

  it('a STALE processing row (lease expired) IS reclaimable — a crash never strands the order', () => {
    const store = openFormPendingStore(':memory:');
    // A handler claimed the row long ago then crashed (SIGKILL) before a terminal mark.
    store.put(
      formSession({ status: 'processing', claimedAt: '2020-01-01T00:00:00.000Z' })
    );

    expect(store.claim('sub_1')).toBe(true); // reclaimed → a redelivery re-drives the order
    const reclaimed = store.get('sub_1');
    expect(reclaimed?.status).toBe('processing');
    // The lease was renewed, so it is not immediately reclaimable again.
    expect(new Date(reclaimed!.claimedAt!).getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime()
    );
    expect(store.claim('sub_1')).toBe(false);
  });

  it('claim stamps claimed_at so the lease clock starts on a pending → processing win', () => {
    const store = openFormPendingStore(':memory:');
    store.put(formSession()); // pending, no claimed_at
    expect(store.get('sub_1')?.claimedAt).toBeUndefined();
    expect(store.claim('sub_1')).toBe(true);
    expect(store.get('sub_1')?.claimedAt).toBeDefined();
  });
});

describe('openFormPendingStore — upgradePayload + countByCheckoutId (findings C/B)', () => {
  it('upgradePayload fills the payment payload + pinned key WITHOUT touching status/resumeToken', () => {
    const store = openFormPendingStore(':memory:');
    // A row parked off a passthrough get/update: no payment payload to re-drive yet.
    store.put(formSession({ paymentPayload: null, idempotencyKey: 'idem-old', status: 'pending' }));

    store.upgradePayload('sub_1', { payment_data: { handler_id: 'h' } }, 'idem-new');

    const got = store.get('sub_1');
    expect(got?.paymentPayload).toEqual({ payment_data: { handler_id: 'h' } });
    expect(got?.idempotencyKey).toBe('idem-new');
    expect(got?.status).toBe('pending'); // NOT reset
    expect(got?.resumeToken).toBe('rt_abc123'); // preserved
  });

  it('countByCheckoutId counts every row for a checkout (bounds runaway rounds)', () => {
    const store = openFormPendingStore(':memory:');
    expect(store.countByCheckoutId('co_42')).toBe(0);
    store.put(formSession({ submissionId: 'sub_1' }));
    store.put(formSession({ submissionId: 'sub_2' }));
    expect(store.countByCheckoutId('co_42')).toBe(2);
    expect(store.countByCheckoutId('co_other')).toBe(0);
  });
});
