/**
 * AgentLens evidence wiring (task #12): every gated purchase self-emits a
 * hash-chained per-checkout timeline. These tests drive the emit sites with a
 * STUB recorder and assert the right events / sessionId / correlation metadata,
 * plus the load-bearing FAIL-OPEN guarantee: a recorder that throws or rejects
 * must never change the tool result.
 */
import { describe, expect, it } from 'vitest';

import type { Gate, GateContext, GateDecision } from '../src/gate/agentgate';
import { gateCompleteCheckout } from '../src/gate/complete';
import type { MerchantClient } from '../src/merchant/client';
import type { AgentLensEventInput, EvidenceRecorder } from '../src/observability/agentlens';
import { openParkedStore } from '../src/store/parked';
import type { Checkout, CheckoutFacts } from '../src/types';
import { handleDecisionWebhook } from '../src/webhook/receiver';

// ─── Stubs ──────────────────────────────────────────────────────────

/** Records every event batch the code under test emits. */
function makeStubRecorder(): { recorder: EvidenceRecorder; events: AgentLensEventInput[] } {
  const events: AgentLensEventInput[] = [];
  const recorder: EvidenceRecorder = {
    logEvents(batch) {
      events.push(...batch);
      return Promise.resolve();
    },
  };
  return { recorder, events };
}

/** A recorder that SYNCHRONOUSLY throws — proves the emit seam can't break a checkout. */
const throwingRecorder: EvidenceRecorder = {
  logEvents() {
    throw new Error('boom: AgentLens client blew up synchronously');
  },
};

/** A recorder that returns a REJECTED promise — the other fail-open shape. */
const rejectingRecorder: EvidenceRecorder = {
  logEvents() {
    return Promise.reject(new Error('boom: AgentLens ingest rejected'));
  },
};

function makeStubMerchant(authoritative: Checkout): MerchantClient {
  const stub = {
    base: 'https://merchant.example',
    getCheckout() {
      return Promise.resolve(authoritative);
    },
    completeCheckout(id: string) {
      return Promise.resolve({
        ...authoritative,
        id,
        status: 'completed',
        order: { id: 'ord_777' },
      } as Checkout);
    },
  };
  return stub as unknown as MerchantClient;
}

function makeStubGate(decision: GateDecision): Gate {
  return {
    evaluate(_facts: CheckoutFacts, _ctx: GateContext) {
      return Promise.resolve(decision);
    },
    continueUrl(id) {
      return `https://gate.example/requests/${id}`;
    },
  };
}

const AGENT_META = {
  'ucp-agent': { profile: 'https://platform.example/agent.json' },
  'idempotency-key': 'key-abc',
};

const MERCHANT_CHECKOUT: Checkout = {
  id: 'co_9',
  status: 'ready_for_complete',
  currency: 'USD',
  totals: [
    { type: 'items', amount: 6500 },
    { type: 'total', amount: 7000 },
  ],
  line_items: [{ id: 'li_1' }, { id: 'li_2' }],
};

/** Index the recorded events by their payload.type for terse assertions. */
function byType(events: AgentLensEventInput[]): Map<string, AgentLensEventInput> {
  return new Map(events.map((e) => [e.payload.type, e]));
}

// ─── complete_checkout emit sites ───────────────────────────────────

describe('evidence — gateCompleteCheckout (approved)', () => {
  it('emits received → decision → order.placed on ucp_<checkout> with correlation metadata', async () => {
    const { recorder, events } = makeStubRecorder();
    const merchant = makeStubMerchant(MERCHANT_CHECKOUT);
    const gate = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_9', checkout: { payment_data: {} } },
      {},
      undefined,
      recorder
    );
    expect(res.isError).toBeFalsy();

    const types = events.map((e) => e.payload.type);
    expect(types).toEqual([
      'ucp.complete_checkout.received',
      'ucp.gate.decision',
      'ucp.order.placed',
    ]);

    // All events share one session + the buying agent identity.
    for (const e of events) {
      expect(e.sessionId).toBe('ucp_co_9');
      expect(e.agentId).toBe('https://platform.example/agent.json');
      expect(e.eventType).toBe('custom');
      expect(e.severity).toBe('info');
      expect(e.metadata).toMatchObject({
        checkoutId: 'co_9',
        idempotencyKey: 'key-abc',
        source: 'agentgate-ucp',
      });
    }

    const m = byType(events);
    expect(m.get('ucp.complete_checkout.received')?.payload.data).toMatchObject({
      checkoutId: 'co_9',
      totals_total_minor: 7000,
      currency: 'USD',
      line_count: 2,
      line_item_ids: ['li_1', 'li_2'],
      idempotencyKey: 'key-abc',
    });
    expect(m.get('ucp.gate.decision')?.payload.data).toMatchObject({ status: 'approved' });
    expect(m.get('ucp.order.placed')?.payload.data).toMatchObject({
      orderId: 'ord_777',
      idempotencyKey: 'key-abc',
    });
  });
});

describe('evidence — gateCompleteCheckout (denied)', () => {
  it('emits received → decision → order.denied carrying the agentgateRequestId + reason', async () => {
    const { recorder, events } = makeStubRecorder();
    const merchant = makeStubMerchant(MERCHANT_CHECKOUT);
    const gate = makeStubGate({
      status: 'denied',
      reason: 'Over the $50 spend limit.',
      approvalId: 'req_denied',
    });

    await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_9', checkout: {} },
      {},
      undefined,
      recorder
    );

    const m = byType(events);
    expect([...m.keys()]).toEqual([
      'ucp.complete_checkout.received',
      'ucp.gate.decision',
      'ucp.order.denied',
    ]);
    expect(m.get('ucp.gate.decision')?.payload.data).toMatchObject({
      status: 'denied',
      agentgateRequestId: 'req_denied',
      reason: 'Over the $50 spend limit.',
    });
    const denied = m.get('ucp.order.denied');
    expect(denied?.payload.data).toMatchObject({
      agentgateRequestId: 'req_denied',
      reason: 'Over the $50 spend limit.',
    });
    expect(denied?.metadata).toMatchObject({ agentgateRequestId: 'req_denied' });
  });
});

describe('evidence — gateCompleteCheckout (pending → parked)', () => {
  it('emits received → decision → order.parked with the continueUrl', async () => {
    const { recorder, events } = makeStubRecorder();
    const merchant = makeStubMerchant(MERCHANT_CHECKOUT);
    const gate = makeStubGate({ status: 'pending', approvalId: 'req_park' });
    const store = openParkedStore(':memory:');

    await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_9', checkout: {} },
      { mcpSessionId: 'sess_42' },
      store,
      recorder
    );

    const m = byType(events);
    expect([...m.keys()]).toEqual([
      'ucp.complete_checkout.received',
      'ucp.gate.decision',
      'ucp.order.parked',
    ]);
    expect(m.get('ucp.order.parked')?.payload.data).toMatchObject({
      agentgateRequestId: 'req_park',
      continueUrl: 'https://gate.example/requests/req_park',
    });

    // The parked row carries the agent id so a later resume event stays attributed.
    expect(store.get('req_park')?.agentId).toBe('https://platform.example/agent.json');
  });
});

describe('evidence — agentId fallback', () => {
  it('uses ucp-anonymous when meta carries no ucp-agent', async () => {
    const { recorder, events } = makeStubRecorder();
    const merchant = makeStubMerchant(MERCHANT_CHECKOUT);
    const gate = makeStubGate({ status: 'approved' });

    await gateCompleteCheckout(
      merchant,
      gate,
      { meta: { 'idempotency-key': 'key-xyz' }, id: 'co_9', checkout: {} },
      {},
      undefined,
      recorder
    );

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.agentId).toBe('ucp-anonymous');
  });
});

// ─── webhook resume emit site ───────────────────────────────────────

/** Build the exact AgentGate decision envelope + its HMAC. */
function envelope(event: 'request.approved' | 'request.denied', requestId: string): string {
  return JSON.stringify({
    event,
    data: { request: { id: requestId, action: 'ucp.complete_checkout', params: {}, status: 'approved' } },
    timestamp: Date.now(),
  });
}

function seedPending(store = openParkedStore(':memory:')) {
  store.put({
    approvalId: 'req_1',
    checkoutId: 'co_9',
    idempotencyKey: 'idem-abc',
    agentId: 'https://platform.example/agent.json',
    mcpSessionId: 'sess_7',
    checkoutSnapshot: { payment_data: { handler_id: 'mock_payment_handler' } },
    merchantBaseUrl: 'https://merchant.example',
    status: 'pending',
    orderResult: null,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
  });
  return store;
}

function webhookMerchant(): MerchantClient {
  const stub = {
    base: 'https://merchant.example',
    completeCheckout(id: string) {
      return Promise.resolve({ id, status: 'completed', order: { id: 'ord_replay' } });
    },
  };
  return stub as unknown as MerchantClient;
}

describe('evidence — handleDecisionWebhook (approved replay)', () => {
  it('emits ucp.order.replayed on the SAME ucp_<checkout> session, correct correlation', async () => {
    const { recorder, events } = makeStubRecorder();
    const store = seedPending();

    const result = await handleDecisionWebhook(
      { store, merchant: webhookMerchant(), webhookSecret: undefined, recorder },
      envelope('request.approved', 'req_1'),
      undefined
    );

    expect(result.outcome).toBe('approved_replayed');
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.sessionId).toBe('ucp_co_9'); // chains onto the completion's session
    expect(ev.agentId).toBe('https://platform.example/agent.json'); // preserved from the parked row
    expect(ev.payload.type).toBe('ucp.order.replayed');
    expect(ev.payload.data).toMatchObject({
      agentgateRequestId: 'req_1',
      orderId: 'ord_replay',
      idempotencyKey: 'idem-abc',
    });
    expect(ev.metadata).toMatchObject({
      checkoutId: 'co_9',
      agentgateRequestId: 'req_1',
      idempotencyKey: 'idem-abc',
      source: 'agentgate-ucp',
    });
  });
});

describe('evidence — handleDecisionWebhook (denied)', () => {
  it('emits ucp.order.webhook_denied', async () => {
    const { recorder, events } = makeStubRecorder();
    const store = seedPending();

    const result = await handleDecisionWebhook(
      { store, merchant: webhookMerchant(), webhookSecret: undefined, recorder },
      envelope('request.denied', 'req_1'),
      undefined
    );

    expect(result.outcome).toBe('denied');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.type).toBe('ucp.order.webhook_denied');
    expect(events[0]!.payload.data).toMatchObject({ agentgateRequestId: 'req_1' });
  });
});

// ─── FAIL-OPEN (the load-bearing guarantee) ─────────────────────────

describe('evidence — fail-open: a broken recorder never breaks the checkout', () => {
  it('approved completion still succeeds when the recorder THROWS synchronously', async () => {
    const merchant = makeStubMerchant(MERCHANT_CHECKOUT);
    const gate = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_9', checkout: {} },
      {},
      undefined,
      throwingRecorder
    );

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Checkout).status).toBe('completed');
  });

  it('pending park still succeeds when the recorder REJECTS', async () => {
    const merchant = makeStubMerchant(MERCHANT_CHECKOUT);
    const gate = makeStubGate({ status: 'pending', approvalId: 'req_park' });
    const store = openParkedStore(':memory:');

    const res = await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_9', checkout: {} },
      {},
      store,
      rejectingRecorder
    );

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Checkout).status).toBe('requires_escalation');
    // The park still happened — evidence failure did not corrupt the resume path.
    expect(store.get('req_park')?.status).toBe('pending');
  });

  it('webhook replay still places the order when the recorder THROWS', async () => {
    const store = seedPending();
    const result = await handleDecisionWebhook(
      { store, merchant: webhookMerchant(), webhookSecret: undefined, recorder: throwingRecorder },
      envelope('request.approved', 'req_1'),
      undefined
    );
    expect(result.outcome).toBe('approved_replayed');
    expect(store.get('req_1')?.status).toBe('approved_replayed');
  });

  it('the result is byte-identical whether a recorder is present, absent, or broken', async () => {
    const run = (recorder?: EvidenceRecorder) =>
      gateCompleteCheckout(
        makeStubMerchant(MERCHANT_CHECKOUT),
        makeStubGate({ status: 'approved' }),
        { meta: AGENT_META, id: 'co_9', checkout: {} },
        {},
        undefined,
        recorder
      );

    const [absent, present, broken] = await Promise.all([
      run(undefined),
      run(makeStubRecorder().recorder),
      run(throwingRecorder),
    ]);

    expect(absent.structuredContent).toEqual(present.structuredContent);
    expect(absent.structuredContent).toEqual(broken.structuredContent);
  });
});
