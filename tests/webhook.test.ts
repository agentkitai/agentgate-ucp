import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { MerchantClient } from '../src/merchant/client';
import type { ParkedSession, ParkedSessionStore } from '../src/store/parked';
import { openParkedStore } from '../src/store/parked';
import { handleDecisionWebhook } from '../src/webhook/receiver';

const SECRET = 'whsec_test';

/** AgentGate signs the RAW body as HMAC-SHA256 hex, no prefix (see webhook.ts). */
function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Build the exact `{ event, data: { request }, timestamp }` envelope AgentGate sends. */
function envelope(
  event: 'request.approved' | 'request.denied',
  requestId: string,
  params: unknown = { checkout_id: 'co_9', idempotency_key: 'idem-abc' }
): string {
  return JSON.stringify({
    event,
    data: {
      request: {
        id: requestId,
        action: 'ucp.complete_checkout',
        params,
        context: {},
        status: event === 'request.approved' ? 'approved' : 'denied',
        decidedAt: '2026-07-04T00:00:00.000Z',
        decidedBy: 'user_1',
        decisionReason: event === 'request.denied' ? 'Over limit' : null,
      },
    },
    timestamp: Date.now(),
  });
}

interface CompleteCall {
  id: string;
  body: unknown;
  headers?: { ucpAgent?: string | undefined; idempotencyKey?: string | undefined };
}

/** Recording stub merchant; `completeCheckout` optionally throws to exercise the error path. */
function makeStubMerchant(opts: { throwOnComplete?: Error } = {}): {
  merchant: MerchantClient;
  completes: CompleteCall[];
} {
  const completes: CompleteCall[] = [];
  const stub = {
    base: 'https://merchant.example',
    completeCheckout(id: string, body: unknown, headers: CompleteCall['headers']) {
      completes.push({ id, body, headers });
      if (opts.throwOnComplete) throw opts.throwOnComplete;
      return Promise.resolve({ id, status: 'completed', order: { id: 'ord_1' } });
    },
  };
  return { merchant: stub as unknown as MerchantClient, completes };
}

/** Seed a store with a single pending parked row. */
function seedPending(overrides: Partial<ParkedSession> = {}): ParkedSessionStore {
  const store = openParkedStore(':memory:');
  store.put({
    approvalId: 'req_1',
    checkoutId: 'co_9',
    idempotencyKey: 'idem-abc',
    mcpSessionId: 'sess_7',
    checkoutSnapshot: { payment_data: { handler_id: 'mock_payment_handler' } },
    merchantBaseUrl: 'https://merchant.example',
    status: 'pending',
    orderResult: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  });
  return store;
}

describe('handleDecisionWebhook — approved', () => {
  it('replays complete_checkout with the row checkoutId + snapshot + original idempotency-key', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.approved', 'req_1');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('approved_replayed');
    expect(completes).toHaveLength(1);
    expect(completes[0]?.id).toBe('co_9');
    expect(completes[0]?.body).toEqual({ payment_data: { handler_id: 'mock_payment_handler' } });
    expect(completes[0]?.headers?.idempotencyKey).toBe('idem-abc');

    const row = store.get('req_1');
    expect(row?.status).toBe('approved_replayed');
    expect(row?.orderResult).toEqual({ id: 'co_9', status: 'completed', order: { id: 'ord_1' } });
  });
});

describe('handleDecisionWebhook — denied', () => {
  it('records denied and never calls the merchant', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.denied', 'req_1');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('denied');
    expect(completes).toHaveLength(0);
    expect(store.get('req_1')?.status).toBe('denied');
  });
});

describe('handleDecisionWebhook — at-least-once safety (status guard)', () => {
  it('a duplicate approved delivery is ignored — no second replay', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.approved', 'req_1');
    const sig = sign(body);

    const first = await handleDecisionWebhook({ store, merchant, webhookSecret: SECRET }, body, sig);
    const second = await handleDecisionWebhook({ store, merchant, webhookSecret: SECRET }, body, sig);

    expect(first.outcome).toBe('approved_replayed');
    expect(second.outcome).toBe('ignored');
    // The merchant was hit exactly once despite two identical deliveries.
    expect(completes).toHaveLength(1);
  });
});

describe('handleDecisionWebhook — unknown request id', () => {
  it('is ignored with no merchant call', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.approved', 'req_UNKNOWN');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('ignored');
    expect(completes).toHaveLength(0);
    // The real pending row is untouched.
    expect(store.get('req_1')?.status).toBe('pending');
  });
});

describe('handleDecisionWebhook — invalid signature', () => {
  it('rejects and mutates neither store nor merchant', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.approved', 'req_1');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: SECRET },
      body,
      sign(body, 'the-wrong-secret')
    );

    expect(result.outcome).toBe('rejected');
    expect(completes).toHaveLength(0);
    expect(store.get('req_1')?.status).toBe('pending');
  });

  it('rejects a missing signature when a secret is configured', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.approved', 'req_1');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: SECRET },
      body,
      undefined
    );

    expect(result.outcome).toBe('rejected');
    expect(completes).toHaveLength(0);
  });
});

describe('handleDecisionWebhook — params normalization', () => {
  it('parses params whether delivered as an object or a JSON string', async () => {
    for (const params of [
      { checkout_id: 'co_9', idempotency_key: 'idem-abc' },
      JSON.stringify({ checkout_id: 'co_9', idempotency_key: 'idem-abc' }),
    ]) {
      const store = seedPending();
      const { merchant, completes } = makeStubMerchant();
      const body = envelope('request.approved', 'req_1', params);

      const result = await handleDecisionWebhook(
        { store, merchant, webhookSecret: SECRET },
        body,
        sign(body)
      );

      expect(result.outcome).toBe('approved_replayed');
      expect(completes).toHaveLength(1);
    }
  });
});

describe('handleDecisionWebhook — merchant error on replay', () => {
  it('marks the row error and returns error (acked, not retried)', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant({
      throwOnComplete: new Error('merchant complete_checkout failed (409): already completed'),
    });
    const body = envelope('request.approved', 'req_1');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('error');
    expect(completes).toHaveLength(1);
    expect(store.get('req_1')?.status).toBe('error');
  });
});

describe('handleDecisionWebhook — dev mode (no secret)', () => {
  it('processes without a signature when webhookSecret is unset', async () => {
    const store = seedPending();
    const { merchant, completes } = makeStubMerchant();
    const body = envelope('request.approved', 'req_1');

    const result = await handleDecisionWebhook(
      { store, merchant, webhookSecret: undefined },
      body,
      undefined
    );

    expect(result.outcome).toBe('approved_replayed');
    expect(completes).toHaveLength(1);
  });
});
