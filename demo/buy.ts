/**
 * demo/buy.ts — the "unattended buying agent".
 *
 * A script (nobody is watching it) that connects an MCP client to the gate
 * (agentgate-ucp) at $GATE_URL/mcp — exactly as it would to a merchant's UCP
 * checkout endpoint — and drives FOUR purchases:
 *
 *   Scenario A (over the spend policy → approval loop):
 *     create_checkout (2 × bouquet_roses = 7000 minor, > 5000) → complete_checkout
 *     → gate PARKS it and returns `requires_escalation` + approval_id. A human
 *     approves in AgentGate; the decision webhook fires; the gate replays the
 *     completion with the ORIGINAL idempotency-key; the order completes.
 *
 *   Scenario B (under the spend policy → auto-approve):
 *     create_checkout (1 × bouquet_roses = 3500 minor, < 5000) → complete_checkout
 *     → gate auto-approves and completes IMMEDIATELY (no escalation).
 *
 *   Scenario C (merchant-native escalation → surfaced, NOT placed) [gate point 2]:
 *     create_checkout (3 × pot_ceramic = 4500 minor, < 5000) → complete_checkout
 *     → the spend gate APPROVES, then the merchant answers with a NON-buyer-input
 *     `requires_escalation` (a bulk inventory-review hold). The adapter must
 *     surface the hold + continue_url faithfully — it is NOT a placed order.
 *
 *   Scenario D (merchant buyer-input → typed FormBridge form) [gate point 3],
 *   END-TO-END with the REAL AgentGate gate and REAL FormBridge:
 *     create_checkout (1 × orchid_white = 4500 minor, < 5000) → complete_checkout
 *     → spend gate APPROVES, merchant answers `requires_buyer_input` (needs a
 *     delivery phone) → adapter registers a TYPED FormBridge intake + submission
 *     and returns an escalation whose continue_url is the human's resume URL. A
 *     simulated human fills the phone in FormBridge and submits → FormBridge fires
 *     the SIGNED answer-back webhook → the adapter update_checkout's the phone and
 *     RE-DRIVES complete_checkout through the REAL spend gate → the order completes.
 *     Finally we verify the tamper-evident AgentLens evidence chain (Tier-A).
 *
 * Config (env):
 *   GATE_URL             gate MCP base            (default http://localhost:8787)
 *   AGENTGATE_URL        AgentGate API base       (default http://localhost:4000)
 *   AGENTGATE_API_KEY    admin agk_ key — used to POST the human approval decision
 *   FORMBRIDGE_URL       FormBridge API base      (enables Scenario D)
 *   AGENTLENS_URL        AgentLens base           (enables the evidence beat)
 *
 * Exit code 0 iff every enabled scenario passes its assertions.
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
// FormBridge is optional — Scenario D is skipped (with a clear note) when unset.
const FORMBRIDGE_URL = (process.env.FORMBRIDGE_URL ?? '').replace(/\/+$/, '');

/** The subset of the UCP Checkout the buying agent reads back. */
interface Checkout {
  id: string;
  status: string;
  order_id?: string;
  order_permalink_url?: string;
  approval_id?: string;
  continue_url?: string;
  totals?: Array<{ type: string; amount: number }>;
  messages?: Array<{ type: string; code?: string; content?: string; severity?: string; path?: string }>;
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
 * Fetch the Tier-A AgentLens evidence chain for this checkout and RETURN it. The
 * gate self-emits a hash-chained per-checkout timeline (session `ucp_<checkoutId>`);
 * here the agent independently verifies it. Best-effort: returns undefined when
 * AgentLens is unset or unreachable (it must never fail the demo).
 */
async function fetchEvidence(
  checkoutId: string
): Promise<{ verified?: boolean; totalEvents?: number; firstHash?: string | null; lastHash?: string | null } | undefined> {
  if (!AGENTLENS_URL) return undefined;
  const sessionId = `ucp_${checkoutId}`;
  try {
    const headers: Record<string, string> = {};
    if (AGENTLENS_API_KEY) headers['Authorization'] = `Bearer ${AGENTLENS_API_KEY}`;
    const res = await fetch(
      `${AGENTLENS_URL}/api/audit/verify?sessionId=${encodeURIComponent(sessionId)}`,
      { headers }
    );
    if (!res.ok) {
      log(`   ⚠ evidence verify returned HTTP ${res.status}`);
      return undefined;
    }
    return (await res.json()) as Awaited<ReturnType<typeof fetchEvidence>>;
  } catch (err) {
    log(`   (AgentLens unreachable — skipping evidence: ${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

/** Print a best-effort evidence chain (used by scenarios that don't hard-assert it). */
async function verifyEvidence(checkoutId: string): Promise<void> {
  if (!AGENTLENS_URL) {
    log('   (AGENTLENS_URL unset — skipping evidence verification)');
    return;
  }
  const body = await fetchEvidence(checkoutId);
  if (!body) return;
  const events = body.totalEvents ?? 0;
  if (body.verified && events > 0) {
    const fh = (body.firstHash ?? '').slice(0, 12);
    const lh = (body.lastHash ?? '').slice(0, 12);
    log(`   ✅ evidence chain verified — ${events} events, ${fh}…${lh}`);
  } else {
    log(`   ⚠ evidence not verified (verified=${body.verified}, events=${events})`);
  }
}

async function pollUntilCompleted(client: Client, id: string, timeoutMs = 20000): Promise<Checkout> {
  const start = Date.now();
  let last: Checkout | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await getCheckout(client, id);
    if (last.status === 'completed') return last;
    await sleep(500);
  }
  fail(`checkout ${id} did not reach 'completed' within ${timeoutMs}ms (last status=${last?.status})`);
}

// ─── FormBridge driving (Scenario D — simulate the human) ───────────────────

async function fbFetch(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${FORMBRIDGE_URL}${path}`, init);
  const text = await res.text();
  const json = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) fail(`FormBridge ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return json;
}

/**
 * Simulate the human resolving the typed form in FormBridge: from the escalation's
 * continue_url (which carries the resume token), discover the submission, PATCH the
 * missing field, then SUBMIT — which fires FormBridge's SIGNED answer-back webhook
 * to the adapter. Returns the field key filled + the submission id.
 */
async function humanFillsForm(continueUrl: string, phone: string): Promise<{ submissionId: string; fieldKey: string }> {
  const token = new URL(continueUrl).searchParams.get('token');
  if (!token) fail(`no resume token in continue_url: ${continueUrl}`);

  // Discover the submission + intake + the typed schema behind the resume token.
  const resume = (await fbFetch('GET', `/submissions/resume/${encodeURIComponent(token)}`)) as {
    id?: string;
    intakeId?: string;
    schema?: { properties?: Record<string, unknown>; required?: string[] };
  };
  const submissionId = resume.id;
  const intakeId = resume.intakeId;
  if (!submissionId || !intakeId) fail(`FormBridge resume returned no submission/intake: ${JSON.stringify(resume)}`);

  // The adapter composed a TYPED single-field schema; take the (one) required field.
  const props = resume.schema?.properties ?? {};
  const fieldKey = resume.schema?.required?.[0] ?? Object.keys(props)[0] ?? 'buyer__phone_number';
  log(`   FormBridge intake=${intakeId} submission=${submissionId} — typed field: ${fieldKey} (${Object.keys(props).length} field/s)`);

  const human = { kind: 'human', id: 'demo:human-buyer', name: 'Demo Human' };
  // (a) fill the missing field — the resume token ROTATES on every field mutation.
  const patched = (await fbFetch('PATCH', `/intake/${intakeId}/submissions/${submissionId}`, {
    resumeToken: token,
    actor: human,
    fields: { [fieldKey]: phone },
  })) as { resumeToken?: string };
  const rotated = patched.resumeToken;
  if (!rotated) fail('FormBridge PATCH did not return a rotated resumeToken');
  log(`   human filled ${fieldKey}=${phone}; submitting…`);

  // (b) submit with the rotated token → FormBridge fires the SIGNED destination webhook.
  await fbFetch('POST', `/intake/${intakeId}/submissions/${submissionId}/submit`, {
    resumeToken: rotated,
    actor: human,
  });
  return { submissionId, fieldKey };
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

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

async function scenarioC(client: Client): Promise<void> {
  console.log('\n================================================================');
  console.log('SCENARIO C — MERCHANT-NATIVE escalation (gate point 2): approved, then held');
  console.log('================================================================');

  log('C1. create_checkout: 3 × pot_ceramic (@1500) = 4500 minor (under the spend limit)');
  const created = await createCheckout(client, 'pot_ceramic', 3);
  log(`    created checkout ${created.id} (status=${created.status}, total=${totalMinor(created)} minor)`);
  if (totalMinor(created) !== 4500) fail(`expected total 4500, got ${totalMinor(created)}`);

  const idemKey = randomUUID();
  log(`C2. complete_checkout (idempotency-key=${idemKey})`);
  log('    → the spend gate APPROVES (4500 < 5000); the MERCHANT then answers with a');
  log('      non-buyer-input requires_escalation (a bulk inventory-review hold).');
  const completed = await completeCheckout(client, created.id, idemKey);
  const msg = completed.messages?.[0];
  log(`    gate/adapter responded: status=${completed.status}, code=${msg?.code}, severity=${msg?.severity}`);
  log(`       continue_url=${completed.continue_url ?? '(none)'}`);
  log(`       message: ${msg?.content ?? ''}`);

  // The adapter must SURFACE the hold faithfully — NOT report a placed order.
  if (completed.status !== 'requires_escalation') {
    fail(`expected 'requires_escalation' (merchant hold surfaced), got '${completed.status}'`);
  }
  if (completed.order_id) fail(`merchant hold was misreported as a PLACED order (order_id=${completed.order_id})`);
  if (!completed.continue_url) fail('expected a continue_url on the merchant hold');
  if (msg?.severity !== 'requires_buyer_review') {
    fail(`expected a requires_buyer_review hold, got severity '${msg?.severity}'`);
  }
  if (msg?.severity === 'requires_buyer_input' || msg?.path) {
    fail('a plain merchant hold must NOT be a buyer-input escalation (no field path)');
  }

  // And the order must genuinely not be placed on the merchant either.
  const after = await getCheckout(client, created.id);
  if (after.status === 'completed' || after.order_id) {
    fail(`merchant hold actually placed an order (status=${after.status}, order_id=${after.order_id})`);
  }
  log(`C3. get_checkout confirms the order is NOT placed → status=${after.status}, order_id=${after.order_id ?? '(none)'}`);

  log('C4. 🔎 Evidence chain records the hold as an escalation, not a placed order…');
  await verifyEvidence(created.id);

  console.log(`\n   SCENARIO C RESULT: PASS — merchant escalation surfaced faithfully (hold + continue_url, NO order_id).`);
}

async function scenarioD(client: Client): Promise<void> {
  console.log('\n================================================================');
  console.log('SCENARIO D — BUYER-INPUT end-to-end (gate point 3): real FormBridge + real gate');
  console.log('================================================================');

  if (!FORMBRIDGE_URL) {
    console.log('   (FORMBRIDGE_URL unset — Scenario D SKIPPED. Set FORMBRIDGE_URL to run it.)');
    return;
  }

  log('D1. create_checkout: 1 × orchid_white (@4500) = 4500 minor (under the spend limit)');
  const created = await createCheckout(client, 'orchid_white', 1);
  log(`    created checkout ${created.id} (status=${created.status}, total=${totalMinor(created)} minor)`);
  if (totalMinor(created) !== 4500) fail(`expected total 4500, got ${totalMinor(created)}`);

  const idemKey = randomUUID();
  log(`D2. complete_checkout (idempotency-key=${idemKey})`);
  log('    → spend gate APPROVES (4500 < 5000); merchant needs a delivery phone →');
  log('      requires_buyer_input → the adapter mints a TYPED FormBridge form.');
  const escalated = await completeCheckout(client, created.id, idemKey);
  const msg = escalated.messages?.[0];
  log(`    adapter responded: status=${escalated.status}, code=${msg?.code}, severity=${msg?.severity}`);
  log(`       continue_url (human resume)=${escalated.continue_url}`);

  if (escalated.status !== 'requires_escalation') {
    fail(`expected 'requires_escalation' (buyer-input handoff), got '${escalated.status}'`);
  }
  if (escalated.order_id) fail(`buyer-input escalation was misreported as a PLACED order (order_id=${escalated.order_id})`);
  if (msg?.severity !== 'requires_buyer_input') {
    fail(`expected a requires_buyer_input escalation, got severity '${msg?.severity}'`);
  }
  if (!escalated.continue_url) fail('expected a FormBridge resume continue_url');

  log('D3. 🧑  A human opens the FormBridge form and supplies the delivery phone…');
  const { submissionId, fieldKey } = await humanFillsForm(escalated.continue_url, '+15551230000');
  log(`    → FormBridge submission ${submissionId} submitted; SIGNED answer-back webhook fired to the adapter.`);
  log('    → adapter verifies the HMAC, update_checkout(phone), RE-DRIVES complete_checkout');
  log('      through the REAL spend gate with the pinned idempotency-key.');

  log('D4. Agent polls get_checkout until the re-driven order lands…');
  const final = await pollUntilCompleted(client, created.id);
  log(`    ✅ COMPLETED via FormBridge answer-back — checkout=${final.id}, order_id=${final.order_id}`);
  if (!final.order_id) fail('completed checkout has no order_id');

  log('D5. 🔎 Verify the tamper-evident AgentLens evidence chain (Tier-A) for the order…');
  const evidence = await fetchEvidence(created.id);
  if (AGENTLENS_URL) {
    log(`    GET ${AGENTLENS_URL}/api/audit/verify?sessionId=ucp_${created.id}`);
    log(`    → ${JSON.stringify(evidence)}`);
    if (!evidence?.verified) fail(`AgentLens evidence chain not verified: ${JSON.stringify(evidence)}`);
    if ((evidence.totalEvents ?? 0) < 1) fail('AgentLens evidence chain has no events');
    log(`    ✅ verified:true — ${evidence.totalEvents} events (${(evidence.firstHash ?? '').slice(0, 12)}…${(evidence.lastHash ?? '').slice(0, 12)})`);
  } else {
    log('    (AGENTLENS_URL unset — evidence verification skipped)');
  }

  console.log(`\n   SCENARIO D RESULT: PASS — buyer-input resolved via real FormBridge; order placed via the real gate.`);
  console.log(`   fieldKey = ${fieldKey}, order_id = ${final.order_id}`);
}

async function main(): Promise<void> {
  console.log('################################################################');
  console.log('# agentgate-ucp — end-to-end demo: unattended buying agent');
  console.log(`# gate       : ${GATE_URL}/mcp`);
  console.log(`# agentgate  : ${AGENTGATE_URL}`);
  console.log(`# formbridge : ${FORMBRIDGE_URL || '(unset — Scenario D skipped)'}`);
  console.log(`# agentlens  : ${AGENTLENS_URL || '(unset — evidence skipped)'}`);
  console.log('################################################################');

  const client = await connect();
  try {
    const tools = await client.listTools();
    log(`Connected. Gate exposes tools: ${tools.tools.map((t) => t.name).join(', ')}`);
    await scenarioA(client);
    await scenarioB(client);
    await scenarioC(client);
    await scenarioD(client);
  } finally {
    await client.close();
  }

  console.log('\n################################################################');
  console.log('# ✅ DEMO PASSED — all enabled scenarios asserted green.');
  console.log('#   A: over-threshold buy PARKED, then completed via human approval + webhook replay.');
  console.log('#   B: under-threshold buy auto-approved and completed immediately.');
  console.log('#   C: merchant-native escalation surfaced faithfully (hold + continue_url, NOT a placed order).');
  console.log('#   D: merchant buyer-input resolved via real FormBridge form → re-driven through the real gate.');
  console.log('################################################################');
}

main().catch((err) => {
  console.error(`\n################################################################`);
  console.error(`# ❌ DEMO FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`################################################################`);
  process.exit(1);
});
