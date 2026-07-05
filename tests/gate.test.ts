import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { Gate, GateContext, GateDecision } from '../src/gate/agentgate.js';
import { gateCompleteCheckout } from '../src/gate/complete.js';
import { createGateServer } from '../src/mcp/server.js';
import { MerchantClient } from '../src/merchant/client.js';
import { openParkedStore } from '../src/store/parked.js';
import type { Checkout, CheckoutFacts } from '../src/types.js';

/** Recording stub merchant. `getCheckout` returns the AUTHORITATIVE checkout. */
interface MerchantCall {
  method: string;
  id?: string;
  body?: unknown;
  headers?: { ucpAgent?: string | undefined; idempotencyKey?: string | undefined };
}

function makeStubMerchant(authoritative: Checkout): {
  merchant: MerchantClient;
  calls: MerchantCall[];
} {
  const calls: MerchantCall[] = [];
  const stub = {
    base: 'https://merchant.example',
    createCheckout(body: unknown, headers: MerchantCall['headers']) {
      calls.push({ method: 'createCheckout', body, headers });
      return Promise.resolve(authoritative);
    },
    getCheckout(id: string, headers: MerchantCall['headers']) {
      calls.push({ method: 'getCheckout', id, headers });
      return Promise.resolve(authoritative);
    },
    updateCheckout(id: string, body: unknown, headers: MerchantCall['headers']) {
      calls.push({ method: 'updateCheckout', id, body, headers });
      return Promise.resolve(authoritative);
    },
    completeCheckout(id: string, body: unknown, headers: MerchantCall['headers']) {
      calls.push({ method: 'completeCheckout', id, body, headers });
      return Promise.resolve({ ...authoritative, id, status: 'completed' } as Checkout);
    },
    cancelCheckout(id: string, headers: MerchantCall['headers']) {
      calls.push({ method: 'cancelCheckout', id, headers });
      return Promise.resolve({ ...authoritative, id, status: 'canceled' } as Checkout);
    },
  };
  return { merchant: stub as unknown as MerchantClient, calls };
}

/** Stub gate: records what it was asked to evaluate and returns a fixed decision. */
interface GateCall {
  facts: CheckoutFacts;
  ctx: GateContext;
}

function makeStubGate(decision: GateDecision): { gate: Gate; calls: GateCall[] } {
  const calls: GateCall[] = [];
  const gate: Gate = {
    evaluate(facts, ctx) {
      calls.push({ facts, ctx });
      return Promise.resolve(decision);
    },
    continueUrl(id) {
      return `https://gate.example/requests/${id}`;
    },
  };
  return { gate, calls };
}

const AGENT_META = {
  'ucp-agent': { profile: 'https://platform.example/agent.json' },
  'idempotency-key': 'key-abc',
};

/** Merchant GET returns total=7000 (authoritative); items entry is a decoy. */
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

describe('gateCompleteCheckout — approved', () => {
  it('forwards to the merchant with the pinned idempotency-key and returns the order', async () => {
    const { merchant, calls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate } = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(merchant, gate, {
      meta: AGENT_META,
      id: 'co_9',
      checkout: { payment_data: { handler_id: 'mock_payment_handler' } },
    });

    const complete = calls.find((c) => c.method === 'completeCheckout');
    expect(complete).toBeDefined();
    expect(complete?.id).toBe('co_9');
    expect(complete?.body).toEqual({ payment_data: { handler_id: 'mock_payment_handler' } });
    expect(complete?.headers?.idempotencyKey).toBe('key-abc');

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ id: 'co_9', status: 'completed' });
  });
});

describe('gateCompleteCheckout — denied', () => {
  it('does NOT complete; returns requires_escalation with a requires_buyer_review error (not isError)', async () => {
    const { merchant, calls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate } = makeStubGate({
      status: 'denied',
      reason: 'Over the $50 spend limit.',
      approvalId: 'req_denied',
    });

    const res = await gateCompleteCheckout(merchant, gate, {
      meta: AGENT_META,
      id: 'co_9',
      checkout: {},
    });

    expect(calls.some((c) => c.method === 'completeCheckout')).toBe(false);
    expect(res.isError).toBeFalsy();

    const sc = res.structuredContent as Checkout;
    expect(sc.status).toBe('requires_escalation');
    expect(sc.continue_url).toBe('https://gate.example/requests/req_denied');
    expect(sc.messages?.[0]).toMatchObject({
      type: 'error',
      code: 'policy_denied',
      severity: 'requires_buyer_review',
      content: 'Over the $50 spend limit.',
    });
    // The text content mirrors the structured checkout.
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('requires_escalation');
  });
});

describe('gateCompleteCheckout — pending', () => {
  it('does NOT complete; returns requires_escalation carrying approval_id + continue_url', async () => {
    const { merchant, calls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate } = makeStubGate({ status: 'pending', approvalId: 'req_pending' });

    const res = await gateCompleteCheckout(merchant, gate, {
      meta: AGENT_META,
      id: 'co_9',
      checkout: {},
    });

    expect(calls.some((c) => c.method === 'completeCheckout')).toBe(false);
    expect(res.isError).toBeFalsy();

    const sc = res.structuredContent as Checkout & { approval_id?: string };
    expect(sc.status).toBe('requires_escalation');
    expect(sc.approval_id).toBe('req_pending');
    expect(sc.continue_url).toBe('https://gate.example/requests/req_pending');
    expect(sc.messages?.[0]).toMatchObject({
      type: 'info',
      code: 'pending_approval',
      severity: 'requires_buyer_review',
    });
  });
});

describe('gateCompleteCheckout — authoritative totals + idempotency', () => {
  it('gates on the merchant GET total (7000), ignoring the agent-supplied amount', async () => {
    const { merchant, calls: mCalls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate, calls: gCalls } = makeStubGate({ status: 'approved' });

    await gateCompleteCheckout(merchant, gate, {
      meta: AGENT_META,
      id: 'co_9',
      // Agent tries to under-report — must be ignored in favour of the GET.
      checkout: { totals: [{ type: 'total', amount: 1 }] },
    });

    expect(mCalls[0]?.method).toBe('getCheckout');
    expect(gCalls).toHaveLength(1);
    expect(gCalls[0]?.facts.totals_total_minor).toBe(7000);
    expect(gCalls[0]?.facts.currency).toBe('USD');
    expect(gCalls[0]?.facts.line_count).toBe(2);
    expect(gCalls[0]?.ctx.agentId).toBe('https://platform.example/agent.json');
  });

  it('generates + pins an idempotency-key when the agent omits one', async () => {
    const { merchant, calls: mCalls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate, calls: gCalls } = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(merchant, gate, {
      // No 'idempotency-key' in meta.
      meta: { 'ucp-agent': { profile: 'https://x/y.json' } },
      id: 'co_9',
      checkout: {},
    });

    const generated = gCalls[0]?.ctx.idempotencyKey ?? '';
    expect(generated.length).toBeGreaterThan(0);
    // The SAME generated key is forwarded to the merchant complete (replay-safe).
    const complete = mCalls.find((c) => c.method === 'completeCheckout');
    expect(complete?.headers?.idempotencyKey).toBe(generated);
    expect(res.isError).toBeFalsy();
  });

  it('missing id → isError, no merchant/gate calls', async () => {
    const { merchant, calls: mCalls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate, calls: gCalls } = makeStubGate({ status: 'approved' });
    const res = await gateCompleteCheckout(merchant, gate, { meta: AGENT_META });
    expect(res.isError).toBe(true);
    expect(mCalls).toHaveLength(0);
    expect(gCalls).toHaveLength(0);
  });
});

describe('gateCompleteCheckout — pending parks a row (task #10)', () => {
  it('puts a pending row with the approvalId/checkoutId/idempotency-key/snapshot', async () => {
    const { merchant } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate } = makeStubGate({ status: 'pending', approvalId: 'req_park' });
    const store = openParkedStore(':memory:');
    const snapshot = { payment_data: { handler_id: 'mock_payment_handler' } };

    const res = await gateCompleteCheckout(
      merchant,
      gate,
      { meta: AGENT_META, id: 'co_9', checkout: snapshot },
      { mcpSessionId: 'sess_42' },
      store
    );

    // Escalation is still returned to the agent.
    expect((res.structuredContent as { approval_id?: string }).approval_id).toBe('req_park');

    const parked = store.get('req_park');
    expect(parked).toBeDefined();
    expect(parked?.checkoutId).toBe('co_9');
    expect(parked?.idempotencyKey).toBe('key-abc'); // pinned from AGENT_META
    expect(parked?.checkoutSnapshot).toEqual(snapshot);
    expect(parked?.mcpSessionId).toBe('sess_42');
    expect(parked?.merchantBaseUrl).toBe('https://merchant.example');
    expect(parked?.status).toBe('pending');
  });

  it('without a store injected, pending behaves exactly as task #9 (no throw)', async () => {
    const { merchant, calls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate } = makeStubGate({ status: 'pending', approvalId: 'req_nostore' });

    const res = await gateCompleteCheckout(merchant, gate, {
      meta: AGENT_META,
      id: 'co_9',
      checkout: {},
    });

    expect(calls.some((c) => c.method === 'completeCheckout')).toBe(false);
    expect((res.structuredContent as Checkout).status).toBe('requires_escalation');
  });
});

describe('gateCompleteCheckout — re-binds the gated total to the charge (finding H2)', () => {
  it('REFUSES to complete when the total changed between the gate GET and the charge', async () => {
    // getCheckout returns 5000 the first time (gated), 500000 on the pre-charge recheck
    // (a concurrent ungated update_checkout mutated the cart during the eval window).
    let n = 0;
    const totals = [5000, 500000];
    const calls: string[] = [];
    const merchant = {
      base: 'https://merchant.example',
      getCheckout() {
        calls.push('getCheckout');
        const amount = totals[Math.min(n++, totals.length - 1)]!;
        return Promise.resolve<Checkout>({
          id: 'co_9',
          status: 'ready_for_complete',
          currency: 'USD',
          totals: [{ type: 'total', amount }],
          line_items: [{ id: 'li_1' }],
        });
      },
      completeCheckout() {
        calls.push('completeCheckout');
        return Promise.resolve<Checkout>({ id: 'co_9', status: 'completed' });
      },
    } as unknown as MerchantClient;
    const { gate } = makeStubGate({ status: 'approved' }); // gate approved the 5000 cart

    const res = await gateCompleteCheckout(merchant, gate, {
      meta: AGENT_META,
      id: 'co_9',
      checkout: {},
    });

    // The order is NOT placed: the drift from the approved total is caught pre-charge.
    expect(calls).not.toContain('completeCheckout');
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as { text?: string } | undefined)?.text).toMatch(/changed after/);
  });

  it('REFUSES on a currency/line-item swap that preserves the total (all facts compared)', async () => {
    // Same total on both GETs, but the currency changes — a cart the gate never saw.
    let n = 0;
    const currencies = ['USD', 'JPY'];
    const calls: string[] = [];
    const merchant = {
      base: 'https://merchant.example',
      getCheckout() {
        calls.push('getCheckout');
        return Promise.resolve<Checkout>({
          id: 'co_9',
          status: 'ready_for_complete',
          currency: currencies[Math.min(n++, 1)]!,
          totals: [{ type: 'total', amount: 5000 }], // total UNCHANGED
          line_items: [{ id: 'li_1' }],
        });
      },
      completeCheckout() {
        calls.push('completeCheckout');
        return Promise.resolve<Checkout>({ id: 'co_9', status: 'completed' });
      },
    } as unknown as MerchantClient;
    const { gate } = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(merchant, gate, { meta: AGENT_META, id: 'co_9', checkout: {} });
    expect(calls).not.toContain('completeCheckout');
    expect(res.isError).toBe(true);
  });

  it('SURFACES (not errors) when the checkout escalates during the eval window', async () => {
    // First GET is completable; the pre-charge recheck finds a buyer-input escalation.
    let n = 0;
    const calls: string[] = [];
    const merchant = {
      base: 'https://merchant.example',
      getCheckout() {
        calls.push('getCheckout');
        if (n++ === 0) {
          return Promise.resolve<Checkout>({
            id: 'co_9',
            status: 'ready_for_complete',
            currency: 'USD',
            totals: [{ type: 'total', amount: 5000 }],
            line_items: [{ id: 'li_1' }],
          });
        }
        return Promise.resolve<Checkout>({
          id: 'co_9',
          status: 'requires_escalation',
          messages: [
            { type: 'error', code: 'buyer_input_required', severity: 'requires_buyer_input', path: '$.buyer.phone_number' },
          ],
        });
      },
      completeCheckout() {
        calls.push('completeCheckout');
        return Promise.resolve<Checkout>({ id: 'co_9', status: 'completed' });
      },
    } as unknown as MerchantClient;
    const { gate } = makeStubGate({ status: 'approved' });

    const res = await gateCompleteCheckout(merchant, gate, { meta: AGENT_META, id: 'co_9', checkout: {} });
    // No order placed, and it is surfaced as an escalation — NOT an opaque MCP error.
    expect(calls).not.toContain('completeCheckout');
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Checkout).status).toBe('requires_escalation');
  });
});

describe('createGateServer with a gate (end-to-end over MCP)', () => {
  it('routes complete_checkout through the gate; leaves other tools as passthrough', async () => {
    const { merchant, calls: mCalls } = makeStubMerchant(MERCHANT_CHECKOUT);
    const { gate, calls: gCalls } = makeStubGate({ status: 'pending', approvalId: 'req_e2e' });
    const server = createGateServer({ merchant, gate });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // create_checkout is NOT gated — straight passthrough, gate untouched.
    await client.callTool({
      name: 'create_checkout',
      arguments: { meta: AGENT_META, checkout: { line_items: [] } },
    });
    expect(gCalls).toHaveLength(0);
    expect(mCalls.some((c) => c.method === 'createCheckout')).toBe(true);

    // complete_checkout IS gated → pending escalation, no merchant complete.
    const res = (await client.callTool({
      name: 'complete_checkout',
      arguments: { meta: AGENT_META, id: 'co_9', checkout: {} },
    })) as CallToolResult;

    expect(gCalls).toHaveLength(1);
    expect(mCalls.some((c) => c.method === 'completeCheckout')).toBe(false);
    expect((res.structuredContent as Checkout).status).toBe('requires_escalation');
    expect((res.structuredContent as { approval_id?: string }).approval_id).toBe('req_e2e');
  });
});
