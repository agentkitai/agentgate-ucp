import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import type { Gate, GateContext, GateDecision } from '../src/gate/agentgate';
import { gateCompleteCheckout } from '../src/gate/complete';
import { createGateServer } from '../src/mcp/server';
import { MerchantClient } from '../src/merchant/client';
import type { Checkout, CheckoutFacts } from '../src/types';

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
