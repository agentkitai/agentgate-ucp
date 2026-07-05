/**
 * Gate point 2 — a MERCHANT-NATIVE `requires_escalation` that is NOT buyer-input
 * (a plain merchant hold: `status: requires_escalation` + a `requires_buyer_review`
 * / `recoverable` message + a `continue_url`, and NO `requires_buyer_input`
 * message) must be surfaced FAITHFULLY by the adapter through BOTH seams:
 *
 *   1. passthrough (create/get/update via `dispatchToolCall`) — the escalation
 *      round-trips untouched (status + messages + continue_url intact), never
 *      diverted into the buyer-input form handoff;
 *   2. the post-gate complete path (`gateCompleteCheckout`) — after the spend gate
 *      APPROVES and `merchant.completeCheckout` returns the hold, the adapter
 *      returns it faithfully and records it as `ucp.order.escalated`, NOT as a
 *      placed order (`ucp.order.placed` with a phantom orderId). The spend-gate
 *      evidence (received + decision) must STILL be emitted — the gate did approve;
 *      the merchant then held the order.
 */
import { describe, expect, it } from 'vitest';

import type { Gate, GateContext, GateDecision } from '../src/gate/agentgate.js';
import { gateCompleteCheckout } from '../src/gate/complete.js';
import { dispatchToolCall } from '../src/mapping.js';
import type { MerchantClient } from '../src/merchant/client.js';
import type { AgentLensEventInput, EvidenceRecorder } from '../src/observability/agentlens.js';
import type { Checkout, CheckoutFacts } from '../src/types.js';

// ─── A merchant-native NON-buyer-input escalation (a plain inventory hold) ────
const MERCHANT_ESCALATION: Checkout = {
  id: 'co_hold',
  status: 'requires_escalation',
  currency: 'USD',
  continue_url: 'https://merchant.example/holds/co_hold',
  messages: [
    {
      type: 'info',
      code: 'inventory_hold',
      severity: 'requires_buyer_review',
      content: 'Item on inventory hold, review required.',
    },
  ],
};

/** The authoritative checkout the gate GETs for policy facts (under threshold). */
const AUTHORITATIVE: Checkout = {
  id: 'co_hold',
  status: 'ready_for_complete',
  currency: 'USD',
  totals: [{ type: 'total', amount: 2000 }],
  line_items: [{ id: 'li_1' }],
};

const AGENT_META = {
  'ucp-agent': { profile: 'https://platform.example/agent.json' },
  'idempotency-key': 'key-hold',
};

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

/** Merchant whose GET is authoritative and whose complete returns the hold. */
function makeStubMerchant(completeReply: Checkout): MerchantClient {
  const stub = {
    base: 'https://merchant.example',
    getCheckout() {
      return Promise.resolve(AUTHORITATIVE);
    },
    createCheckout() {
      return Promise.resolve(completeReply);
    },
    updateCheckout() {
      return Promise.resolve(completeReply);
    },
    completeCheckout(id: string) {
      return Promise.resolve({ ...completeReply, id } as Checkout);
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

function types(events: AgentLensEventInput[]): string[] {
  return events.map((e) => e.payload.type);
}

/** A pure passthrough merchant: every read/write returns the given checkout. */
function makePassthroughMerchant(reply: Checkout): MerchantClient {
  const echo = () => Promise.resolve(reply);
  const stub = {
    base: 'https://merchant.example',
    getCheckout: echo,
    createCheckout: echo,
    updateCheckout: echo,
    completeCheckout: echo,
    cancelCheckout: echo,
  };
  return stub as unknown as MerchantClient;
}

// ─── 1. PASSTHROUGH ───────────────────────────────────────────────────────────
describe('gate-2 — passthrough surfaces a merchant escalation faithfully', () => {
  for (const tool of ['get_checkout', 'create_checkout', 'update_checkout'] as const) {
    it(`${tool} round-trips status + messages + continue_url untouched`, async () => {
      const merchant = makePassthroughMerchant(MERCHANT_ESCALATION);
      const args: Record<string, unknown> = { meta: AGENT_META };
      if (tool !== 'create_checkout') args['id'] = 'co_hold';
      if (tool !== 'get_checkout') args['checkout'] = {};

      const res = await dispatchToolCall(merchant, tool, args);
      expect(res.isError).toBeFalsy();

      const sc = res.structuredContent as Checkout;
      // Faithful: NOT converted, NOT dropped, NOT reported as a placed order.
      expect(sc.status).toBe('requires_escalation');
      expect(sc.continue_url).toBe('https://merchant.example/holds/co_hold');
      expect(sc.messages).toEqual(MERCHANT_ESCALATION.messages);
      expect(sc.order_id).toBeUndefined();
      expect(sc.order).toBeUndefined();
    });
  }
});

// ─── 2. POST-GATE COMPLETE PATH ─────────────────────────────────────────────────
describe('gate-2 — approved complete then a merchant hold is surfaced, not placed', () => {
  it('returns the escalation faithfully (not a placed order) and records ucp.order.escalated', async () => {
    const { recorder, events } = makeStubRecorder();
    const merchant = makeStubMerchant(MERCHANT_ESCALATION);
    const gate = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_hold', checkout: { payment_data: { handler_id: 'mock' } } },
      {},
      undefined,
      recorder
    );

    // The buying agent sees the raw merchant hold, faithfully.
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Checkout;
    expect(sc.status).toBe('requires_escalation');
    expect(sc.continue_url).toBe('https://merchant.example/holds/co_hold');
    expect(sc.messages).toEqual(MERCHANT_ESCALATION.messages);
    // NOT a placed order.
    expect(sc.order_id).toBeUndefined();
    expect(sc.order).toBeUndefined();

    // The escalation is NOT misreported as a placed order in the evidence chain…
    expect(types(events)).toEqual([
      'ucp.complete_checkout.received',
      'ucp.gate.decision',
      'ucp.order.escalated',
    ]);
    expect(types(events)).not.toContain('ucp.order.placed');

    // …but the spend-gate evidence is STILL emitted (the gate DID approve).
    const byType = new Map(events.map((e) => [e.payload.type, e]));
    expect(byType.get('ucp.gate.decision')?.payload.data).toMatchObject({ status: 'approved' });
    const escalated = byType.get('ucp.order.escalated');
    expect(escalated?.payload.data).toMatchObject({
      status: 'requires_escalation',
      continueUrl: 'https://merchant.example/holds/co_hold',
      idempotencyKey: 'key-hold',
    });
    // No orderId is claimed on a hold.
    expect(escalated?.payload.data['orderId']).toBeUndefined();
    // Correlation is preserved on the escalation event.
    for (const e of events) {
      expect(e.sessionId).toBe('ucp_co_hold');
      expect(e.agentId).toBe('https://platform.example/agent.json');
    }
  });

  it('a genuinely completed order still records ucp.order.placed (no regression)', async () => {
    const { recorder, events } = makeStubRecorder();
    const merchant = makeStubMerchant({
      id: 'co_hold',
      status: 'completed',
      order: { id: 'ord_ok' },
    });
    const gate = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_hold', checkout: {} },
      {},
      undefined,
      recorder
    );

    expect((res.structuredContent as Checkout).status).toBe('completed');
    expect(types(events)).toEqual([
      'ucp.complete_checkout.received',
      'ucp.gate.decision',
      'ucp.order.placed',
    ]);
    const placed = new Map(events.map((e) => [e.payload.type, e])).get('ucp.order.placed');
    expect(placed?.payload.data).toMatchObject({ orderId: 'ord_ok' });
  });
});
