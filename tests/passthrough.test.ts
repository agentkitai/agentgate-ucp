import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  dispatchToolCall,
  extractHeaders,
  formatUcpAgent,
  TOOL_DEFINITIONS,
} from '../src/mapping.js';
import { MerchantClient, MerchantError } from '../src/merchant/client.js';
import { createGateServer } from '../src/mcp/server.js';
import type { Checkout, CheckoutToolName } from '../src/types.js';
import { CHECKOUT_TOOL_NAMES } from '../src/types.js';

/** A recording stub standing in for the real MerchantClient. */
interface RecordedCall {
  method: string;
  id?: string;
  body?: unknown;
  headers?: { ucpAgent?: string | undefined; idempotencyKey?: string | undefined };
}

function makeStubMerchant(
  reply: Checkout | { throw: MerchantError } = { id: 'co_1', status: 'incomplete' }
): { merchant: MerchantClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const returnOrThrow = (): Checkout => {
    if ('throw' in reply) throw reply.throw;
    return reply;
  };
  const stub = {
    createCheckout(body: unknown, headers: RecordedCall['headers']) {
      calls.push({ method: 'createCheckout', body, headers });
      return Promise.resolve(returnOrThrow());
    },
    getCheckout(id: string, headers: RecordedCall['headers']) {
      calls.push({ method: 'getCheckout', id, headers });
      return Promise.resolve(returnOrThrow());
    },
    updateCheckout(id: string, body: unknown, headers: RecordedCall['headers']) {
      calls.push({ method: 'updateCheckout', id, body, headers });
      return Promise.resolve(returnOrThrow());
    },
    completeCheckout(id: string, body: unknown, headers: RecordedCall['headers']) {
      calls.push({ method: 'completeCheckout', id, body, headers });
      return Promise.resolve(returnOrThrow());
    },
    cancelCheckout(id: string, headers: RecordedCall['headers']) {
      calls.push({ method: 'cancelCheckout', id, headers });
      return Promise.resolve(returnOrThrow());
    },
  };
  return { merchant: stub as unknown as MerchantClient, calls };
}

const AGENT_META = {
  'ucp-agent': { profile: 'https://platform.example/agent.json' },
  'idempotency-key': 'key-123',
};

describe('header mapping', () => {
  it('serialises a ucp-agent object into a structured-header string', () => {
    expect(formatUcpAgent({ profile: 'https://x/y.json' })).toBe('profile="https://x/y.json"');
    expect(
      formatUcpAgent({ profile: 'https://x/y.json', version: '2026-01-01' })
    ).toBe('profile="https://x/y.json", version="2026-01-01"');
  });

  it('passes a ucp-agent string through untouched', () => {
    expect(formatUcpAgent('profile="https://z"')).toBe('profile="https://z"');
  });

  it('extracts UCP-Agent + Idempotency-Key from meta', () => {
    const headers = extractHeaders(AGENT_META);
    expect(headers.ucpAgent).toBe('profile="https://platform.example/agent.json"');
    expect(headers.idempotencyKey).toBe('key-123');
  });

  it('tolerates missing/empty meta', () => {
    expect(extractHeaders(undefined)).toEqual({ ucpAgent: undefined, idempotencyKey: undefined });
    expect(extractHeaders({})).toEqual({ ucpAgent: undefined, idempotencyKey: undefined });
  });
});

describe('dispatchToolCall — 1:1 passthrough', () => {
  const CHECKOUT: Checkout = {
    id: 'co_9',
    status: 'ready_for_complete',
    currency: 'USD',
    totals: [{ type: 'total', amount: 5500 }],
  };
  const CHECKOUT_PAYLOAD = { line_items: [{ item: { id: 'bouquet_roses' }, quantity: 1 }] };

  it('create_checkout → merchant.createCheckout(body, headers) and wraps the result', async () => {
    const { merchant, calls } = makeStubMerchant(CHECKOUT);
    const res = await dispatchToolCall(merchant, 'create_checkout', {
      meta: AGENT_META,
      checkout: CHECKOUT_PAYLOAD,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'createCheckout',
      body: CHECKOUT_PAYLOAD,
      headers: {
        ucpAgent: 'profile="https://platform.example/agent.json"',
        idempotencyKey: 'key-123',
      },
    });
    // Result wrapping: structuredContent + stringified content[0].text.
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(CHECKOUT);
    const content = res.content?.[0];
    expect(content).toEqual({ type: 'text', text: JSON.stringify(CHECKOUT) });
  });

  it('get_checkout → merchant.getCheckout(id, headers)', async () => {
    const { merchant, calls } = makeStubMerchant(CHECKOUT);
    await dispatchToolCall(merchant, 'get_checkout', { meta: AGENT_META, id: 'co_9' });
    expect(calls[0]).toMatchObject({ method: 'getCheckout', id: 'co_9' });
  });

  it('update_checkout → merchant.updateCheckout(id, body, headers)', async () => {
    const { merchant, calls } = makeStubMerchant(CHECKOUT);
    await dispatchToolCall(merchant, 'update_checkout', {
      meta: AGENT_META,
      id: 'co_9',
      checkout: CHECKOUT_PAYLOAD,
    });
    expect(calls[0]).toMatchObject({
      method: 'updateCheckout',
      id: 'co_9',
      body: CHECKOUT_PAYLOAD,
    });
  });

  it('complete_checkout → merchant.completeCheckout(id, body, headers)', async () => {
    const { merchant, calls } = makeStubMerchant(CHECKOUT);
    const payment = { payment_data: { handler_id: 'mock_payment_handler' } };
    await dispatchToolCall(merchant, 'complete_checkout', {
      meta: AGENT_META,
      id: 'co_9',
      checkout: payment,
    });
    expect(calls[0]).toMatchObject({
      method: 'completeCheckout',
      id: 'co_9',
      body: payment,
      headers: { idempotencyKey: 'key-123' },
    });
  });

  it('cancel_checkout → merchant.cancelCheckout(id, headers)', async () => {
    const { merchant, calls } = makeStubMerchant(CHECKOUT);
    await dispatchToolCall(merchant, 'cancel_checkout', { meta: AGENT_META, id: 'co_9' });
    expect(calls[0]).toMatchObject({ method: 'cancelCheckout', id: 'co_9' });
  });

  it('MerchantError → isError result (does not throw)', async () => {
    const err = new MerchantError(404, { detail: 'Checkout session not found' }, 'get_checkout');
    const { merchant } = makeStubMerchant({ throw: err });
    const res = await dispatchToolCall(merchant, 'get_checkout', { meta: AGENT_META, id: 'nope' });
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('404');
    expect(text).toContain('Checkout session not found');
  });

  it('missing id → isError result (does not throw)', async () => {
    const { merchant, calls } = makeStubMerchant(CHECKOUT);
    const res = await dispatchToolCall(merchant, 'get_checkout', { meta: AGENT_META });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('TOOL_DEFINITIONS', () => {
  it('defines exactly the 5 UCP checkout tools with input schemas', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...CHECKOUT_TOOL_NAMES]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toHaveProperty('meta');
    }
  });
});

describe('createGateServer over an MCP client (end-to-end)', () => {
  let client: Client;
  let calls: RecordedCall[];

  async function connect(reply?: Checkout | { throw: MerchantError }): Promise<void> {
    const stub = makeStubMerchant(reply);
    calls = stub.calls;
    const server = createGateServer({ merchant: stub.merchant });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-agent', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  beforeEach(async () => {
    await connect();
  });

  it('ListTools returns exactly the 5 tools with inputSchema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CHECKOUT_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('CallTool create_checkout forwards to the merchant and returns structuredContent', async () => {
    const res = (await client.callTool({
      name: 'create_checkout',
      arguments: { meta: AGENT_META, checkout: { line_items: [] } },
    })) as CallToolResult;
    expect(calls[0]?.method).toBe('createCheckout');
    expect(res.structuredContent).toMatchObject({ id: 'co_1', status: 'incomplete' });
    expect(res.isError).toBeFalsy();
  });

  it('all 5 tools dispatch to their merchant method', async () => {
    const argsById: Record<CheckoutToolName, Record<string, unknown>> = {
      create_checkout: { meta: AGENT_META, checkout: {} },
      get_checkout: { meta: AGENT_META, id: 'co_1' },
      update_checkout: { meta: AGENT_META, id: 'co_1', checkout: {} },
      complete_checkout: { meta: AGENT_META, id: 'co_1', checkout: {} },
      cancel_checkout: { meta: AGENT_META, id: 'co_1' },
    };
    const expected: Record<CheckoutToolName, string> = {
      create_checkout: 'createCheckout',
      get_checkout: 'getCheckout',
      update_checkout: 'updateCheckout',
      complete_checkout: 'completeCheckout',
      cancel_checkout: 'cancelCheckout',
    };
    for (const name of CHECKOUT_TOOL_NAMES) {
      await client.callTool({ name, arguments: argsById[name] });
    }
    expect(calls.map((c) => c.method)).toEqual(
      CHECKOUT_TOOL_NAMES.map((n) => expected[n])
    );
  });

  it('unknown tool → MCP error', async () => {
    await expect(
      client.callTool({ name: 'not_a_tool', arguments: {} })
    ).rejects.toThrow(/Unknown tool/);
  });
});
