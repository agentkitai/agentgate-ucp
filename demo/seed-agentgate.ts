/**
 * demo/seed-agentgate.ts — seed a RUNNING AgentGate for the demo, via the SDK.
 *
 * Run this AFTER the AgentGate server is up (it talks to it over HTTP) and
 * BEFORE starting the gate (the gate needs the webhook secret it prints).
 *
 * It creates:
 *   1. A GLOBAL spend policy (priority 10):
 *        params.checkout.totals_total_minor $gt 5000 → route_to_human  (park for approval)
 *        params.checkout.totals_total_minor $lt 5000 → auto_approve     (complete immediately)
 *   2. A webhook → $GATE_WEBHOOK_URL for events request.approved / request.denied,
 *      and prints the returned HMAC `secret` so the caller can pass it to the gate
 *      as AGENTGATE_WEBHOOK_SECRET.
 *
 * Config (env):
 *   AGENTGATE_URL      default http://localhost:4000
 *   AGENTGATE_API_KEY  an admin agk_ key (required)
 *   GATE_WEBHOOK_URL   default http://localhost:8787/agentgate/webhook
 *
 * Output: a single JSON line on stdout: { policyId, webhookId, webhookSecret }.
 * All human-readable progress goes to stderr so stdout stays machine-parseable.
 */
import { AgentGateClient } from '@agentkitai/agentgate-sdk';

const AGENTGATE_URL = process.env.AGENTGATE_URL ?? 'http://localhost:4000';
const AGENTGATE_API_KEY = process.env.AGENTGATE_API_KEY ?? '';
const GATE_WEBHOOK_URL = process.env.GATE_WEBHOOK_URL ?? 'http://localhost:8787/agentgate/webhook';

function info(msg: string): void {
  process.stderr.write(`[seed] ${msg}\n`);
}

async function main(): Promise<void> {
  if (!AGENTGATE_API_KEY) throw new Error('AGENTGATE_API_KEY is required');

  const client = new AgentGateClient({ baseUrl: AGENTGATE_URL, apiKey: AGENTGATE_API_KEY });

  info(`Creating global spend policy on ${AGENTGATE_URL}…`);
  const policy = await client.createPolicy({
    name: 'demo-ucp-spend-policy',
    priority: 10,
    enabled: true,
    rules: [
      {
        // Over the limit → a human must approve (parks the completion).
        match: { 'params.checkout.totals_total_minor': { $gt: 5000 } },
        decision: 'route_to_human',
      },
      {
        // Under the limit → auto-approve (complete immediately).
        match: { 'params.checkout.totals_total_minor': { $lt: 5000 } },
        decision: 'auto_approve',
      },
    ],
  });
  info(`  policy id=${policy.id} name=${policy.name}`);

  info(`Creating decision webhook → ${GATE_WEBHOOK_URL}…`);
  const webhook = await client.createWebhook({
    url: GATE_WEBHOOK_URL,
    events: ['request.approved', 'request.denied'],
  });
  info(`  webhook id=${webhook.id} events=${webhook.events.join(',')}`);
  info(`  secret captured (${webhook.secret.length} chars) — pass to the gate as AGENTGATE_WEBHOOK_SECRET`);

  // Machine-readable result on stdout (single line).
  process.stdout.write(
    JSON.stringify({ policyId: policy.id, webhookId: webhook.id, webhookSecret: webhook.secret }) + '\n'
  );
}

main().catch((err) => {
  process.stderr.write(`[seed] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
