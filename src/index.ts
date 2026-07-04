import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { FormBridgeClient } from './formbridge/client.js';
import { PolicyGate } from './gate/agentgate.js';
import type { HandoffDeps } from './handoff/run.js';
import { MerchantClient } from './merchant/client.js';
import { AgentLensRecorder } from './observability/agentlens.js';
import { openFormPendingStore } from './store/form-pending.js';
import { openParkedStore } from './store/parked.js';

const config = loadConfig();
const merchant = new MerchantClient(config.merchantUrl);
const gate = new PolicyGate({ baseUrl: config.agentgateUrl, apiKey: config.agentgateApiKey });
const store = openParkedStore(config.sqlitePath);
// Best-effort, fail-open evidence sink. No-op when AGENTLENS_URL is unset.
const recorder = new AgentLensRecorder({
  url: config.agentlensUrl,
  apiKey: config.agentlensApiKey,
  agentToken: config.agentlensAgentToken,
});

// FormBridge form-handoff (gate point 3). Entirely optional: with FORMBRIDGE_URL
// unset there is no fbClient, so `handoff` is undefined and a `requires_buyer_input`
// escalation passes through as the RAW UCP escalation (unchanged behaviour).
const formPending = openFormPendingStore(config.sqlitePath);
const fbClient =
  config.formbridgeUrl !== undefined
    ? new FormBridgeClient({ baseUrl: config.formbridgeUrl, apiKey: config.formbridgeApiKey })
    : undefined;
const handoff: HandoffDeps | undefined =
  fbClient && config.formbridgePublicUrl
    ? {
        fbClient,
        formPending,
        formbridgePublicUrl: config.formbridgePublicUrl,
        adapterWebhookUrl: `${config.publicUrl.replace(/\/+$/, '')}/formbridge/webhook`,
        recorder,
      }
    : undefined;

const app = createApp({
  merchant,
  gate,
  parked: store,
  formPending,
  recorder,
  handoff,
  agentgateWebhookSecret: config.agentgateWebhookSecret,
  formbridgeWebhookSecret: config.formbridgeWebhookSecret,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `[agentgate-ucp] gate on :${info.port} → merchant ${config.merchantUrl}, agentgate ${config.agentgateUrl}`
  );
});
