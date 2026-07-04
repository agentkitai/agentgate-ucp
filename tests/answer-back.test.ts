import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type {
  CreatedSubmission,
  FormBridgeActor,
  FormBridgeClient,
  FormBridgeIntakeDefinition,
} from '../src/formbridge/client';
import type { Gate } from '../src/gate/agentgate';
import { handleAnswerBackWebhook } from '../src/handoff/answer-back';
import type { HandoffDeps } from '../src/handoff/run';
import { MerchantClient, MerchantError } from '../src/merchant/client';
import { openFormPendingStore } from '../src/store/form-pending';
import type { FormPendingStore } from '../src/store/form-pending';
import { openParkedStore } from '../src/store/parked';
import type { Checkout } from '../src/types';

const SECRET = 'whsec_formbridge';

/** FormBridge signs the RAW body as `sha256=<HMAC-SHA256 hex>`. */
function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** The FormBridge destination delivery payload (subset the adapter reads). */
function deliveryBody(fields: Record<string, unknown>, submissionId = 'sub_1'): string {
  return JSON.stringify({
    submissionId,
    intakeId: 'ucp-buyer-input-co_42',
    state: 'submitted',
    fields,
    fieldAttribution: {},
    metadata: {},
  });
}

/** Authoritative merchant checkout returned by GET (full line_items + currency). */
const AUTHORITATIVE: Checkout = {
  id: 'co_42',
  status: 'ready_for_complete',
  currency: 'USD',
  line_items: [{ id: 'line_1', quantity: 1, item: { id: 'prod_1', title: 'Widget', price: 1000 } }],
  totals: [{ type: 'total', amount: 1000 }],
};

interface MerchantCall {
  method: string;
  id?: string;
  body?: unknown;
  headers?: { ucpAgent?: string | undefined; idempotencyKey?: string | undefined };
}

function makeStubMerchant(): { merchant: MerchantClient; calls: MerchantCall[] } {
  const calls: MerchantCall[] = [];
  const stub = {
    base: 'https://merchant.example',
    getCheckout(id: string, headers: MerchantCall['headers']) {
      calls.push({ method: 'getCheckout', id, headers });
      return Promise.resolve(AUTHORITATIVE);
    },
    updateCheckout(id: string, body: unknown, headers: MerchantCall['headers']) {
      calls.push({ method: 'updateCheckout', id, body, headers });
      return Promise.resolve({ ...AUTHORITATIVE, buyer: (body as { buyer?: unknown }).buyer });
    },
    completeCheckout(id: string, body: unknown, headers: MerchantCall['headers']) {
      calls.push({ method: 'completeCheckout', id, body, headers });
      return Promise.resolve({ ...AUTHORITATIVE, id, status: 'completed', order: { id: 'ord_1' } } as Checkout);
    },
  };
  return { merchant: stub as unknown as MerchantClient, calls };
}

function approvingGate(): Gate {
  return {
    evaluate() {
      return Promise.resolve({ status: 'approved' as const });
    },
    continueUrl(id: string) {
      return `https://gate.example/requests/${id}`;
    },
  };
}

function seedPending(store: FormPendingStore): void {
  const now = new Date().toISOString();
  store.put({
    submissionId: 'sub_1',
    checkoutId: 'co_42',
    intakeId: 'ucp-buyer-input-co_42',
    merchantBaseUrl: 'https://merchant.example',
    paymentPayload: { payment_data: { handler_id: 'mock_payment_handler' } },
    idempotencyKey: 'idem-1',
    fieldMap: { buyer__phone_number: '$.buyer.phone_number' },
    agentId: 'agent-1',
    ucpAgent: 'profile="https://platform.example/agent.json"',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
}

describe('handleAnswerBackWebhook — valid signature, buyer-input resolved', () => {
  it('writes the answer at the JSONPath (full line_items reconstructed), re-drives completion, marks resolved', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant, calls } = makeStubMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('resolved');
    expect(result.redriven).toBe(true);

    // The update body is MERCHANT-SHAPED: full line_items from the GET + currency +
    // the buyer object with the answer written at $.buyer.phone_number.
    const update = calls.find((c) => c.method === 'updateCheckout');
    expect(update).toBeDefined();
    const updateBody = update?.body as { line_items?: unknown[]; currency?: string; buyer?: Record<string, unknown> };
    expect(updateBody.line_items).toEqual(AUTHORITATIVE.line_items);
    expect(updateBody.currency).toBe('USD');
    expect(updateBody.buyer?.['phone_number']).toBe('+15551234567');

    // The completion was re-driven through the gate with the pinned idempotency-key.
    const complete = calls.find((c) => c.method === 'completeCheckout');
    expect(complete).toBeDefined();
    expect(complete?.headers?.idempotencyKey).toBe('idem-1');
    expect(complete?.body).toEqual({ payment_data: { handler_id: 'mock_payment_handler' } });

    expect(store.get('sub_1')?.status).toBe('resolved');
  });
});

describe('handleAnswerBackWebhook — invalid signature', () => {
  it('rejects and touches neither the merchant nor the row', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant, calls } = makeStubMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body, 'the-wrong-secret')
    );

    expect(result.outcome).toBe('rejected');
    expect(calls).toHaveLength(0);
    expect(store.get('sub_1')?.status).toBe('pending');
  });
});

describe('handleAnswerBackWebhook — at-least-once safety', () => {
  it('ignores a duplicate delivery once the row is resolved (no second re-drive)', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant, calls } = makeStubMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const first = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body)
    );
    const second = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(first.outcome).toBe('resolved');
    expect(second.outcome).toBe('ignored');
    // Exactly one completion despite two deliveries.
    expect(calls.filter((c) => c.method === 'completeCheckout')).toHaveLength(1);
  });

  it('ignores a delivery for an unknown submission id', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant, calls } = makeStubMerchant();

    const body = deliveryBody({ buyer__phone_number: '+1' }, 'sub_UNKNOWN');
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('ignored');
    expect(calls).toHaveLength(0);
    expect(store.get('sub_1')?.status).toBe('pending');
  });
});

describe('handleAnswerBackWebhook — fail-closed with no secret (finding D)', () => {
  it('REJECTS (never processes) when webhookSecret is unset — no fail-open dev branch', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant, calls } = makeStubMerchant();

    // Even a correctly-shaped delivery is refused: with no secret there is nothing
    // to verify against, so the money endpoint fails CLOSED (was: accepted in dev mode).
    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: undefined },
      body,
      undefined
    );

    expect(result.outcome).toBe('rejected');
    expect(calls).toHaveLength(0); // the merchant is never touched
    expect(store.get('sub_1')?.status).toBe('pending'); // the row is untouched
  });

  it('REJECTS a signed delivery too when the handler has no secret (cannot verify)', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant } = makeStubMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: undefined },
      body,
      sign(body) // a valid-looking signature is still rejected: no secret to check it
    );

    expect(result.outcome).toBe('rejected');
  });
});

describe('handleAnswerBackWebhook — update carries NO idempotency-key (finding: update no-idem-key)', () => {
  it('updateCheckout sends no idempotency-key; the re-driven completion keeps the pinned one', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const { merchant, calls } = makeStubMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body)
    );

    const update = calls.find((c) => c.method === 'updateCheckout');
    expect(update?.headers?.idempotencyKey).toBeUndefined();
    const complete = calls.find((c) => c.method === 'completeCheckout');
    expect(complete?.headers?.idempotencyKey).toBe('idem-1'); // pinned from the parked row
  });
});

describe('handleAnswerBackWebhook — spend gate RE-EVALUATED on re-drive (HIGH invariant)', () => {
  it('a buyer answer that raises the authoritative total ⇒ gate re-evaluated against the NEW total; DENY ⇒ no order, row NOT resolved', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);

    let updated = false;
    const calls: MerchantCall[] = [];
    const merchant = {
      base: 'https://merchant.example',
      getCheckout(id: string, headers: MerchantCall['headers']) {
        calls.push({ method: 'getCheckout', id, headers });
        // The merchant recomputes the total AFTER the buyer's answer is applied.
        return Promise.resolve({
          ...AUTHORITATIVE,
          totals: [{ type: 'total', amount: updated ? 99999 : 1000 }],
        } as Checkout);
      },
      updateCheckout(id: string, body: unknown, headers: MerchantCall['headers']) {
        calls.push({ method: 'updateCheckout', id, body, headers });
        updated = true;
        return Promise.resolve({ ...AUTHORITATIVE, buyer: (body as { buyer?: unknown }).buyer });
      },
      completeCheckout(id: string, body: unknown, headers: MerchantCall['headers']) {
        calls.push({ method: 'completeCheckout', id, body, headers });
        return Promise.resolve({ ...AUTHORITATIVE, id, status: 'completed', order: { id: 'ord_1' } } as Checkout);
      },
    };

    const seenTotals: number[] = [];
    const inspectingGate: Gate = {
      evaluate(facts) {
        seenTotals.push(facts.totals_total_minor);
        return Promise.resolve(
          facts.totals_total_minor > 50000
            ? { status: 'denied' as const, reason: 'Over the spend limit.', approvalId: 'req_over' }
            : { status: 'approved' as const }
        );
      },
      continueUrl: (id: string) => `https://gate.example/requests/${id}`,
    };

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant: merchant as unknown as MerchantClient, gate: inspectingGate, webhookSecret: SECRET },
      body,
      sign(body)
    );

    // The gate was evaluated against the FRESH post-update authoritative total.
    expect(seenTotals.at(-1)).toBe(99999);
    // Denied ⇒ NO order placed, and the row is NOT mislabelled 'resolved'.
    expect(calls.some((c) => c.method === 'completeCheckout')).toBe(false);
    expect(result.outcome).toBe('denied');
    expect(store.get('sub_1')?.status).toBe('denied');
  });
});

describe('handleAnswerBackWebhook — failed re-drive is retryable, not resolved (finding #9)', () => {
  it('merchant 5xx on the re-driven completion ⇒ status error, retryable, row re-claimable', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);

    const merchant = {
      base: 'https://merchant.example',
      getCheckout: () => Promise.resolve(AUTHORITATIVE),
      updateCheckout: (_id: string, body: unknown) =>
        Promise.resolve({ ...AUTHORITATIVE, buyer: (body as { buyer?: unknown }).buyer }),
      completeCheckout: () =>
        Promise.reject(new MerchantError(503, { detail: 'merchant temporarily unavailable' }, 'complete_checkout')),
    };

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant: merchant as unknown as MerchantClient, gate: approvingGate(), webhookSecret: SECRET },
      body,
      sign(body)
    );

    expect(result.outcome).toBe('error');
    expect(result.retryable).toBe(true); // route maps this to a 5xx → FormBridge retries
    expect(store.get('sub_1')?.status).toBe('error'); // NOT 'resolved'
    // The order was not lost: the row is re-claimable so a retry re-drives it.
    expect(store.claim('sub_1')).toBe(true);
  });
});

/** FormBridge stub minting a NEW submission id per createSubmission (sub_2, sub_3…). */
function makeStubFbClient(): { fbClient: FormBridgeClient; submissions: string[] } {
  const submissions: string[] = [];
  let n = 1;
  const stub = {
    registerIntake(_def: FormBridgeIntakeDefinition): Promise<void> {
      return Promise.resolve();
    },
    createSubmission(
      _intakeId: string,
      _opts: { actor: FormBridgeActor; initialFields?: Record<string, unknown>; idempotencyKey?: string }
    ): Promise<CreatedSubmission> {
      n += 1;
      const submissionId = `sub_${n}`;
      submissions.push(submissionId);
      return Promise.resolve({ submissionId, resumeToken: `rt_${submissionId}` });
    },
  };
  return { fbClient: stub as unknown as FormBridgeClient, submissions };
}

function handoffDeps(store: FormPendingStore, fbClient: FormBridgeClient): HandoffDeps {
  return {
    fbClient,
    formPending: store,
    formbridgePublicUrl: 'https://fb.example',
    adapterWebhookUrl: 'https://adapter.example/formbridge/webhook',
  };
}

/** A merchant whose re-driven completion asks for ANOTHER field (round 2: $.buyer.email). */
function makeRenewedBuyerInputMerchant(): MerchantClient {
  const stub = {
    base: 'https://merchant.example',
    getCheckout: () => Promise.resolve(AUTHORITATIVE),
    updateCheckout: (_id: string, body: unknown) =>
      Promise.resolve({ ...AUTHORITATIVE, buyer: (body as { buyer?: unknown }).buyer }),
    completeCheckout: () =>
      Promise.resolve<Checkout>({
        id: 'co_42',
        status: 'requires_escalation',
        messages: [
          {
            type: 'error',
            code: 'buyer_input_required',
            severity: 'requires_buyer_input',
            path: '$.buyer.email',
            content: 'An email is also required.',
          },
        ],
      }),
  };
  return stub as unknown as MerchantClient;
}

describe('handleAnswerBackWebhook — renewed buyer-input on re-drive (finding B)', () => {
  it('WITH handoff: a renewed buyer-input mints a NEW form/row and resolves the round-1 row', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store); // round-1 row sub_1 (phone)
    const { fbClient, submissions } = makeStubFbClient();
    const merchant = makeRenewedBuyerInputMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      {
        store,
        merchant,
        gate: approvingGate(),
        webhookSecret: SECRET,
        handoff: handoffDeps(store, fbClient),
      },
      body,
      sign(body)
    );

    // Round-1 form was answered → resolved; a NEW round-2 form/row was parked.
    expect(result.outcome).toBe('resolved');
    expect(result.redriven).toBe(true);
    expect(store.get('sub_1')?.status).toBe('resolved');

    expect(submissions).toEqual(['sub_2']); // exactly one new submission minted
    const round2 = store.getByCheckoutId('co_42');
    expect(round2?.submissionId).toBe('sub_2');
    expect(round2?.status).toBe('pending');
    expect(round2?.fieldMap).toEqual({ buyer__email: '$.buyer.email' });
    expect(store.countByCheckoutId('co_42')).toBe(2);
  });

  it('WITHOUT handoff: a renewed buyer-input does NOT resolve the row (recoverable, not dropped)', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const merchant = makeRenewedBuyerInputMerchant();

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: approvingGate(), webhookSecret: SECRET }, // no handoff deps
      body,
      sign(body)
    );

    // No form could be minted for the new field → the row must NOT be mislabelled resolved.
    expect(result.outcome).not.toBe('resolved');
    expect(store.get('sub_1')?.status).not.toBe('resolved');
    expect(store.countByCheckoutId('co_42')).toBe(1); // no new row
  });
});

describe('handleAnswerBackWebhook — spend-pending re-drive parks a session (finding #10)', () => {
  it('a PENDING re-drive writes a parked-session row so the decision webhook can place the order', async () => {
    const store = openFormPendingStore(':memory:');
    seedPending(store);
    const parked = openParkedStore(':memory:');
    const { merchant, calls } = makeStubMerchant();

    const pendingGate: Gate = {
      evaluate: () => Promise.resolve({ status: 'pending' as const, approvalId: 'req_park' }),
      continueUrl: (id: string) => `https://gate.example/requests/${id}`,
    };

    const body = deliveryBody({ buyer__phone_number: '+15551234567' });
    const result = await handleAnswerBackWebhook(
      { store, merchant, gate: pendingGate, webhookSecret: SECRET, parked },
      body,
      sign(body)
    );

    // No order placed yet (awaiting spend approval), but a parked row now exists.
    expect(calls.some((c) => c.method === 'completeCheckout')).toBe(false);
    const row = parked.get('req_park');
    expect(row).toBeDefined();
    expect(row?.checkoutId).toBe('co_42');
    expect(row?.idempotencyKey).toBe('idem-1');
    expect(row?.status).toBe('pending');
    // The form-pending row is not stranded (terminal), so retries won't re-park.
    expect(result.outcome).toBe('resolved');
    expect(store.get('sub_1')?.status).toBe('resolved');
  });
});
