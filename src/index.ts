import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';
import type { Context } from 'hono';

import { loadConfig } from './config';
import { createGateServer } from './mcp/server';
import { MerchantClient } from './merchant/client';

const config = loadConfig();
const merchant = new MerchantClient(config.merchantUrl);

type Bindings = { Bindings: HttpBindings };
const app = new Hono<Bindings>();

app.get('/health', (c) => c.json({ ok: true, service: 'agentgate-ucp', version: '0.1.0' }));

/**
 * MCP StreamableHTTP transport (task #8). The buying agent connects its MCP
 * client to `$PUBLIC_URL/mcp` and the gate forwards each UCP checkout tool to
 * the merchant.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh `Server` + transport
 * is created per request so there is no cross-request state or JSON-RPC id
 * collision. `@hono/node-server` exposes the raw Node req/res on `c.env`; we hand
 * them to `transport.handleRequest(...)` with the pre-parsed body and return the
 * `RESPONSE_ALREADY_SENT` sentinel so Hono does not also write a response.
 */
async function handleMcp(c: Context<Bindings>): Promise<Response> {
  const { incoming, outgoing } = c.env;
  const server = createGateServer({ merchant });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  outgoing.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  // POST carries a JSON-RPC body; GET/DELETE do not.
  const body = await c.req.json().catch(() => undefined);
  await transport.handleRequest(incoming, outgoing, body);
  return RESPONSE_ALREADY_SENT;
}

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

// AgentGate decision webhook → resume parked completions (task #10).
app.post('/agentgate/webhook', (c) =>
  c.json({ error: 'webhook receiver not yet wired (task #10)' }, 501)
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[agentgate-ucp] gate on :${info.port} → merchant ${config.merchantUrl}, agentgate ${config.agentgateUrl}`
  );
});
