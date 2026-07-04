# agentgate-ucp — end-to-end demo

Proves the milestone: **an unattended buying agent (a script, nobody watching)
buys over the spend policy → the gate parks it and returns an escalation → a
human approves it in AgentGate → the decision webhook fires → the gate replays
the completion with the original idempotency-key → the order completes.** It also
shows the under-threshold case completing immediately (auto-approve).

See `transcript.txt` for the captured output of a real run.

## What runs (topology)

| Service            | Port  | What                                                        |
| ------------------ | ----- | ---------------------------------------------------------- |
| Sample merchant    | :3100 | `ucp-samples/rest/nodejs` — the merchant's UCP checkout REST API |
| AgentGate          | :4000 | `agentkitai/agentgate` server — spend policy + approvals + decision webhooks |
| The gate           | :8787 | **this repo** — the agentgate-ucp MCP proxy (`npm run dev`) |

```
buy.ts (MCP client) ──MCP /mcp──▶ gate :8787 ──REST──▶ merchant :3100
                                    │  ▲
                     POST /api/requests │  │ decision webhook (HMAC) → /agentgate/webhook
                                    ▼  │
                              AgentGate :4000  ◀── human taps "Approve" (POST /api/requests/:id/decide)
```

Ports: the sample merchant and AgentGate both default to :3000, but **AgentLens
owns :3000** in this environment, so the merchant runs on :3100 and AgentGate on
:4000.

## One command

```bash
bash demo/run-demo.sh
```

It starts all three services against **temp SQLite DBs**, seeds AgentGate, runs
`demo/buy.ts`, tees the console to `demo/transcript.txt`, then tears everything
down and reverts the two local changes below. Override paths/workdir via env
(`MERCHANT_DIR`, `AGENTGATE_DIR`, `WORKDIR`, …) — see the top of the script.

## Two local, uncommitted changes (auto-applied + auto-reverted)

The runner makes two throwaway local edits and restores both on exit:

1. **merchant `src/index.ts` → honor `$PORT`** so it can run on :3100. Reverted
   with `git checkout` in `ucp-samples`. (Also, the sample merchant's
   `better-sqlite3@9` won't build on node-24; a working `better-sqlite3@11`
   prebuilt was dropped into its `node_modules` — a local artifact, not committed.)
2. **AgentGate `dist/lib/url-validator.js` → an env-gated loopback allowance.**
   AgentGate's webhook SSRF guard blocks `localhost`/`127.0.0.1` (and every
   private LAN IP), so it can't deliver the decision webhook to a local gate. The
   runner injects a guard that returns "valid" **only for loopback and only when
   `AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK=1`** (which it sets only for this run); the
   original file is backed up and restored on exit. This is a local demo-only
   shim — in a real deployment the gate has a routable host and no shim is needed.

## Manual steps (what the runner automates)

```bash
# 1. merchant on :3100 (src patched to honor $PORT)
cd ucp-samples/rest/nodejs && PORT=3100 npx tsx src/index.ts
# ready when: curl http://localhost:3100/.well-known/ucp

# 2. mint the first AgentGate admin key (server DOWN — writes the DB directly)
cd agentgate-ucp
AGENTGATE_SERVER_DIR=<…>/agentgate/packages/server DATABASE_URL=<tmp>/agentgate.db \
  npx tsx demo/mint-admin-key.ts            # prints agk_…

# 3. AgentGate on :4000 (built dist, api-key-only, sqlite temp DB)
cd agentgate && PORT=4000 NODE_ENV=development AUTH_MODE=api-key-only \
  DB_DIALECT=sqlite DATABASE_URL=<tmp>/agentgate.db RATE_LIMIT_ENABLED=false \
  AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK=1 node packages/server/dist/index.js
# ready when: curl http://localhost:4000/health

# 4. seed the spend policy + decision webhook (prints the webhook secret)
cd agentgate-ucp
AGENTGATE_URL=http://localhost:4000 AGENTGATE_API_KEY=<agk_…> \
  GATE_WEBHOOK_URL=http://localhost:8787/agentgate/webhook \
  npx tsx demo/seed-agentgate.ts            # → {"policyId","webhookId","webhookSecret"}

# 5. the gate on :8787 (pass the captured webhook secret)
cd agentgate-ucp
PORT=8787 MERCHANT_URL=http://localhost:3100 AGENTGATE_URL=http://localhost:4000 \
  AGENTGATE_API_KEY=<agk_…> AGENTGATE_WEBHOOK_SECRET=<secret> \
  SQLITE_PATH=<tmp>/gate-parked.db npm run dev
# ready when: curl http://localhost:8787/health

# 6. run the unattended buying agent
cd agentgate-ucp
GATE_URL=http://localhost:8787 AGENTGATE_URL=http://localhost:4000 \
  AGENTGATE_API_KEY=<agk_…> npx tsx demo/buy.ts
```

The spend policy seeded in step 4 (global, priority 10):

- `params.checkout.totals_total_minor $gt 5000` → `route_to_human` (park for approval)
- `params.checkout.totals_total_minor $lt 5000` → `auto_approve` (complete immediately)

`buy.ts` buys `bouquet_roses` (@3500 minor): **×2 = 7000** trips the gate
(Scenario A), **×1 = 3500** auto-approves (Scenario B). The human approval in
Scenario A is `POST /api/requests/:id/decide` with the admin key (the AgentGate
SDK doesn't expose a decide method), which fires the `request.approved` webhook.

## Files

| File                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `buy.ts`              | The unattended buying agent (MCP client). Scenarios A + B.     |
| `seed-agentgate.ts`   | Seeds the spend policy + decision webhook via the AgentGate SDK. |
| `mint-admin-key.ts`   | Mints the first AgentGate admin API key straight into its DB.  |
| `run-demo.sh`         | Orchestrator: start → seed → run → capture → teardown/revert.  |
| `transcript.txt`      | Captured output of a real end-to-end run (the evidence).       |

The `demo/` scripts are run with `tsx` and are intentionally OUTSIDE `tsconfig.json`'s
`include` (`src` + `tests` only), so `npm run typecheck` and `npm run test:run`
are unaffected by them.
