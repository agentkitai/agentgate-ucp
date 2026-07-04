import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config';

const config = loadConfig();
const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'agentgate-ucp', version: '0.1.0' }));

// The gate re-exposes the 5 UCP checkout tools over MCP here (task #8).
app.all('/mcp', (c) => c.json({ error: 'MCP transport not yet wired (task #8)' }, 501));

// AgentGate decision webhook → resume parked completions (task #10).
app.post('/agentgate/webhook', (c) => c.json({ error: 'webhook receiver not yet wired (task #10)' }, 501));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[agentgate-ucp] gate on :${info.port} → merchant ${config.merchantUrl}, agentgate ${config.agentgateUrl}`
  );
});
