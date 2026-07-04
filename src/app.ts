/**
 * The Hono HTTP app: MCP transport + the two decision/answer-back webhooks. Built
 * by a pure factory ({@link createApp}) so route wiring is unit-testable (via
 * `app.request(...)`) without binding a socket — `index.ts` builds the runtime deps
 * and calls `serve()`.
 */
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Gate } from './gate/agentgate.js';
import { handleAnswerBackWebhook } from './handoff/answer-back.js';
import type { HandoffDeps } from './handoff/run.js';
import { createGateServer } from './mcp/server.js';
import type { MerchantClient } from './merchant/client.js';
import type { EvidenceRecorder } from './observability/agentlens.js';
import type { FormPendingStore } from './store/form-pending.js';
import type { ParkedSessionStore } from './store/parked.js';
import { handleDecisionWebhook } from './webhook/receiver.js';

export interface AppDeps {
  merchant: MerchantClient;
  gate: Gate;
  /** Parked-session store for the AgentGate decision webhook + spend-pending re-drives. */
  parked: ParkedSessionStore;
  /** Form-pending store for the FormBridge answer-back webhook. */
  formPending: FormPendingStore;
  recorder?: EvidenceRecorder | undefined;
  /** FormBridge handoff bundle (gate point 3). Absent ⇒ buyer-input stays a raw escalation. */
  handoff?: HandoffDeps | undefined;
  /** HMAC secret verifying AgentGate decision webhooks. */
  agentgateWebhookSecret: string | undefined;
  /**
   * HMAC secret verifying FormBridge answer-back webhooks. When UNSET the
   * `/formbridge/webhook` route is NOT registered at all: the answer-back re-drives a
   * payment and must be authenticated, so an unauthenticated (secret-less) deployment
   * exposes NO route rather than a fail-open one (a stale form-pending row must never
   * be re-driven by an unsigned request).
   */
  formbridgeWebhookSecret: string | undefined;
}

type Bindings = { Bindings: HttpBindings };

/** Build the Hono app. Pure: registers routes from `deps`, binds no socket. */
export function createApp(deps: AppDeps): Hono<Bindings> {
  const { merchant, gate, parked, formPending, recorder, handoff } = deps;
  const app = new Hono<Bindings>();

  app.get('/health', (c) => c.json({ ok: true, service: 'agentgate-ucp', version: '0.1.0' }));

  /**
   * MCP StreamableHTTP transport (task #8). Stateless: a fresh Server + transport per
   * request. `@hono/node-server` exposes the raw Node req/res on `c.env`.
   */
  async function handleMcp(c: Context<Bindings>): Promise<Response> {
    const { incoming, outgoing } = c.env;
    const server = createGateServer({ merchant, gate, store: parked, recorder, handoff });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    outgoing.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const body = await c.req.json().catch(() => undefined);
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  }

  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

  /**
   * AgentGate decision webhook → resume parked completions (task #10). The HMAC is
   * computed over the exact bytes AgentGate sent, so we read the RAW body.
   */
  app.post('/agentgate/webhook', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('X-AgentGate-Signature');
    const result = await handleDecisionWebhook(
      { store: parked, merchant, webhookSecret: deps.agentgateWebhookSecret, recorder },
      rawBody,
      signature
    );
    if (result.outcome === 'rejected') {
      return c.json({ ok: false, outcome: result.outcome }, 401);
    }
    if (result.outcome === 'error') {
      console.error(`[agentgate-ucp] webhook processing error: ${result.reason ?? 'unknown'}`);
      return c.json({ ok: false, outcome: result.outcome }, 200);
    }
    return c.json({ ok: true, outcome: result.outcome }, 200);
  });

  /**
   * FormBridge answer-back webhook → resolve a parked buyer-input form (gate point 3).
   *
   * Registered ONLY when a webhook secret is configured (fail-closed): with no secret
   * the endpoint that re-drives a payment simply does not exist, so an unsigned
   * re-drive of a stale form-pending row is impossible. FormBridge signs the RAW body
   * as `sha256=HMAC-SHA256(rawBody, secret)`. NEVER throws.
   */
  if (deps.formbridgeWebhookSecret) {
    app.post('/formbridge/webhook', async (c) => {
      const rawBody = await c.req.text();
      const signature = c.req.header('X-FormBridge-Signature');
      const result = await handleAnswerBackWebhook(
        {
          store: formPending,
          merchant,
          gate,
          webhookSecret: deps.formbridgeWebhookSecret,
          // Thread the parked-session store so a spend-`pending` re-drive parks a row
          // the AgentGate decision webhook can resume; thread the handoff bundle so a
          // RENEWED buyer-input on the re-drive mints a new form (never dropped).
          parked,
          handoff,
          recorder,
        },
        rawBody,
        signature
      );
      if (result.outcome === 'rejected') {
        return c.json({ ok: false, outcome: result.outcome }, 401);
      }
      if (result.outcome === 'error') {
        console.error(`[agentgate-ucp] formbridge webhook error: ${result.reason ?? 'unknown'}`);
        // A transient (retryable) failure returns 5xx so FormBridge retries and the
        // order is not lost; a permanent failure is acked (200) to stop the retry loop.
        return c.json({ ok: false, outcome: result.outcome }, result.retryable ? 500 : 200);
      }
      return c.json({ ok: true, outcome: result.outcome, redriven: result.redriven ?? false }, 200);
    });
  }

  return app;
}
