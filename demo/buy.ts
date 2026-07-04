/**
 * demo/buy.ts — the "unattended buying agent".
 *
 * A script (nobody is watching it) that connects an MCP client to the gate
 * (agentgate-ucp) at $GATE_URL/mcp — exactly as it would to a merchant's UCP
 * checkout endpoint — and drives two purchases:
 *
 *   Scenario A (over the spend policy → approval loop):
 *     create_checkout (total 7000 minor, > 5000) → complete_checkout
 *     → gate PARKS it and returns `requires_escalation` + approval_id.
 *     A human then approves the request in AgentGate; the decision webhook
 *     fires; the gate replays the completion with the ORIGINAL idempotency-key;
 *     the order completes. The agent learns via get_checkout polling.
 *
 *   Scenario B (under the spend policy → auto-approve):
 *     create_checkout (total 3500 minor, < 5000) → complete_checkout
 *     → gate auto-approves and completes IMMEDIATELY (no escalation).
 *
 * Config (env):
 *   GATE_URL          gate MCP base            (default http://localhost:8787)
 *   AGENTGATE_URL     AgentGate API base       (default http://localhost:4000)
 *   AGENTGATE_API_KEY admin agk_ key — used to POST the human approval decision
 *
 * Exit code 0 iff both scenarios pass their assertions.
 */
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const GATE_URL = (process.env.GATE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const AGENTGATE_URL = (process.env.AGENTGATE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const AGENTGATE_API_KEY = process.env.AGENTGATE_API_KEY ?? '';
// AgentLens is optional — the evidence beat is skipped gracefully when unset/unreachable.
const AGENTLENS_URL = (process.env.AGENTLENS_URL ?? '').replace(/\/+$/, '');
const AGENTLENS_API_KEY = process.env.AGENTLENS_API_KEY ?? '';

/** The subset of the UCP Checkout the buying agent reads back. */
interface Checkout {
  id: string;
  status: string;
  order_id?: string;
  order_permalink_url?: string;
  approval_id?: string;
  continue_url?: string;
  totals?: Array<{ type: string; amount: number }>;
  messages?: Array<{ type: string; code?: string; content?: string }>;
  [k: string]: unknown;
}

const AGENT = { profile: 'https://unattended-buyer.demo/agent.json' };

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}
function fail(msg: string): never {
  console.error(`[${ts()}] ASSERT FAILED: ${msg}`);
  throw new Error(msg);
}
function totalMinor(co: Checkout): number {
  return (co.totals ?? []).find((t) => t.type === 'total')?.amount ?? -1;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Unwrap an MCP CallToolResult into a Checkout; throw on an isError result. */
function unwrap(res: CallToolResult, tool: string): Checkout {
  if (res.isError) {
    const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? '(no detail)';
    fail(`${tool} returned an MCP error: ${text}`);
  }
  const sc = res.structuredContent as Checkout | undefined;
  if (!sc || typeof sc !== 'object') fail(`${tool} returned no structuredContent`);
  return sc as Checkout;
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'unattended-buying-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${GATE_URL}/mcp`));
  await client.connect(transport);
  return client;
}

async function createCheckout(client: Client, productId: string, quantity: number): Promise<Checkout> {
  const res = (await client.callTool({
    name: 'create_checkout',
    arguments: {
      meta: { 'ucp-agent': AGENT },
      checkout: {
        currency: 'USD',
        line_items: [{ item: { id: productId }, quantity }],
        payment: {},
      },
    },
  })) as CallToolResult;
  return unwrap(res, 'create_checkout');
}

async function completeCheckout(client: Client, id: string, idempotencyKey: string): Promise<Checkout> {
  const res = (await client.callTool({
    name: 'complete_checkout',
    arguments: {
      meta: { 'ucp-agent': AGENT, 'idempotency-key': idempotencyKey },
      id,
      // The merchant's mock payment: mock_payment_handler + success_token.
      checkout: {
        payment_data: {
          handler_id: 'mock_payment_handler',
          id: 'pi_demo',
          type: 'card',
          brand: 'visa',
          last_digits: '4242',
          credential: { type: 'mock', token: 'success_token' },
        },
      },
    },
  })) as CallToolResult;
  return unwrap(res, 'complete_checkout');
}

async function getCheckout(client: Client, id: string): Promise<Checkout> {
  const res = (await client.callTool({
    name: 'get_checkout',
    arguments: { meta: { 'ucp-agent': AGENT }, id },
  })) as CallToolResult;
  return unwrap(res, 'get_checkout');
}

/** Simulate the human tapping "Approve" in AgentGate (POST /api/requests/:id/decide). */
async function humanApproves(approvalId: string): Promise<void> {
  if (!AGENTGATE_API_KEY) fail('AGENTGATE_API_KEY is required to POST the approval decision');
  const res = await fetch(`${AGENTGATE_URL}/api/requests/${approvalId}/decide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENTGATE_API_KEY}`,
    },
    body: JSON.stringify({
      decision: 'approved',
      decidedBy: 'demo:human-reviewer',
      reason: 'Looks good — approved by a human in AgentGate.',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (!res.ok) fail(`AgentGate decide failed (${res.status}): ${JSON.stringify(body)}`);
  log(`   AgentGate request ${approvalId} → status=${body.status ?? '?'} (decidedBy=demo:human-reviewer)`);
}

/**
 * Fetch + print the Tier-A AgentLens evidence chain for this checkout. The gate
 * self-emits a hash-chained per-checkout timeline (session `ucp_<checkoutId>`);
 * here the agent independently verifies it. Best-effort: skips gracefully when
 * AgentLens is unset or unreachable (it must never fail the demo).
 */
async function verifyEvidence(checkoutId: string): Promise<void> {
  if (!AGENTLENS_URL) {
    log('   (AGENTLENS_URL unset — skipping evidence verification)');
    return;
  }
  const sessionId = `ucp_${checkoutId}`;
  try {
    const headers: Record<string, string> = {};
    if (AGENTLENS_API_KEY) headers['Authorization'] = `Bearer ${AGENTLENS_API_KEY}`;
    const res = await fetch(
      `${AGENTLENS_URL}/api/audit/verify?sessionId=${encodeURIComponent(sessionId)}`,
      { headers }
    );
    if (!res.ok) {
      log(`   ⚠ evidence verify returned HTTP ${res.status} — skipping`);
      return;
    }
    const body = (await res.json()) as {
      verified?: boolean;
      totalEvents?: number;
      firstHash?: string | null;
      lastHash?: string | null;
    };
    const events = body.totalEvents ?? 0;
    if (body.verified && events > 0) {
      const fh = (body.firstHash ?? '').slice(0, 12);
      const lh = (body.lastHash ?? '').slice(0, 12);
      log(`   ✅ evidence chain verified — ${events} events, ${fh}…${lh}`);
    } else {
      log(`   ⚠ evidence not verified (verified=${body.verified}, events=${events})`);
    }
  } catch (err) {
    log(`   (AgentLens unreachable — skipping evidence: ${err instanceof Error ? err.message : String(err)})`);
  }
}

async function pollUntilCompleted(client: Client, id: string, timeoutMs = 15000): Promise<Checkout> {
  const start = Date.now();
  let last: Checkout | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await getCheckout(client, id);
    if (last.status === 'completed') return last;
    await sleep(500);
  }
  fail(`checkout ${id} did not reach 'completed' within ${timeoutMs}ms (last status=${last?.status})`);
}

async function scenarioA(client: Client): Promise<void> {
  console.log('\n================================================================');
  console.log('SCENARIO A — OVER the spend policy (7000 minor > 5000) → approval loop');
  console.log('================================================================');

  log('A1. create_checkout: 2 × bouquet_roses (@3500) = 7000 minor');
  const created = await createCheckout(client, 'bouquet_roses', 2);
  log(`    created checkout ${created.id} (status=${created.status}, total=${totalMinor(created)} minor)`);
  if (totalMinor(created) !== 7000) fail(`expected total 7000, got ${totalMinor(created)}`);

  const idemKey = randomUUID();
  log(`A2. complete_checkout (idempotency-key=${idemKey}) — the agent tries to place the order`);
  const completed = await completeCheckout(client, created.id, idemKey);
  log(`    gate responded: status=${completed.status}, approval_id=${completed.approval_id ?? '(none)'}`);

  if (completed.status !== 'requires_escalation') {
    fail(`expected status 'requires_escalation', got '${completed.status}'`);
  }
  if (!completed.approval_id) fail('expected an approval_id on the escalation');
  if (!completed.continue_url) fail('expected a continue_url on the escalation');
  const approvalId = completed.approval_id;
  log(`    ⏸  PARKED. Nobody is watching the agent — approval_id=${approvalId}`);
  log(`       continue_url=${completed.continue_url}`);
  log(`       message: ${completed.messages?.[0]?.content ?? ''}`);

  // The order must NOT be placed yet.
  const beforeApproval = await getCheckout(client, created.id);
  log(`A3. get_checkout before approval → status=${beforeApproval.status} (order not placed yet)`);
  if (beforeApproval.status === 'completed') fail('checkout completed BEFORE approval — gate did not park!');

  log('A4. 🧑  A human opens AgentGate and taps "Approve"…');
  await humanApproves(approvalId);
  log('    → AgentGate fires the decision webhook → the gate replays the completion');
  log('      with the ORIGINAL idempotency-key.');

  log('A5. Agent polls get_checkout until the order lands…');
  const final = await pollUntilCompleted(client, created.id);
  log(`    ✅ COMPLETED via webhook resume — checkout=${final.id}, order_id=${final.order_id}`);
  if (!final.order_id) fail('completed checkout has no order_id');

  log('A6. 🔎 Verify the tamper-evident AgentLens evidence chain for this checkout…');
  log('    (the gate self-emitted received → decision → parked → replayed on ucp_' + created.id + ')');
  await verifyEvidence(created.id);

  console.log(`\n   SCENARIO A RESULT: PASS — parked over-threshold buy completed only after human approval.`);
  console.log(`   order_id = ${final.order_id}`);
}

async function scenarioB(client: Client): Promise<void> {
  console.log('\n================================================================');
  console.log('SCENARIO B — UNDER the spend policy (3500 minor < 5000) → auto-approve');
  console.log('================================================================');

  log('B1. create_checkout: 1 × bouquet_roses (@3500) = 3500 minor');
  const created = await createCheckout(client, 'bouquet_roses', 1);
  log(`    created checkout ${created.id} (status=${created.status}, total=${totalMinor(created)} minor)`);
  if (totalMinor(created) !== 3500) fail(`expected total 3500, got ${totalMinor(created)}`);

  const idemKey = randomUUID();
  log(`B2. complete_checkout (idempotency-key=${idemKey})`);
  const completed = await completeCheckout(client, created.id, idemKey);
  log(`    gate responded: status=${completed.status}, order_id=${completed.order_id ?? '(none)'}`);

  if (completed.status !== 'completed') {
    fail(`expected IMMEDIATE 'completed', got '${completed.status}' (escalation on an under-threshold buy!)`);
  }
  if (completed.approval_id) fail('under-threshold buy should NOT carry an approval_id');
  if (!completed.order_id) fail('completed checkout has no order_id');
  console.log(`\n   SCENARIO B RESULT: PASS — under-threshold buy completed immediately, no human in the loop.`);
  console.log(`   order_id = ${completed.order_id}`);
}

async function main(): Promise<void> {
  console.log('################################################################');
  console.log('# agentgate-ucp — end-to-end demo: unattended buying agent');
  console.log(`# gate       : ${GATE_URL}/mcp`);
  console.log(`# agentgate  : ${AGENTGATE_URL}`);
  console.log('################################################################');

  const client = await connect();
  try {
    const tools = await client.listTools();
    log(`Connected. Gate exposes tools: ${tools.tools.map((t) => t.name).join(', ')}`);
    await scenarioA(client);
    await scenarioB(client);
  } finally {
    await client.close();
  }

  console.log('\n################################################################');
  console.log('# ✅ DEMO PASSED — both scenarios asserted green.');
  console.log('#   A: over-threshold buy PARKED, then completed via human approval + webhook replay.');
  console.log('#   B: under-threshold buy auto-approved and completed immediately.');
  console.log('################################################################');
}

main().catch((err) => {
  console.error(`\n################################################################`);
  console.error(`# ❌ DEMO FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`################################################################`);
  process.exit(1);
});
