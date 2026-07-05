# agentgate-ucp — end-to-end demo

Drives an unattended buying agent (a script, nobody watching) through **four**
scenarios against the LIVE 5-service stack, asserting each:

- **A — over the spend policy → approval loop.** The gate parks the completion and
  returns an escalation → a human approves it in AgentGate → the decision webhook
  fires → the gate replays the completion with the original idempotency-key → the
  order completes.
- **B — under the spend policy → auto-approve.** Completes immediately, no human.
- **C — merchant-native escalation (gate point 2).** The spend gate APPROVES, then
  the merchant answers with a NON-buyer-input `requires_escalation` (a bulk
  inventory-review hold). The adapter must surface the hold + `continue_url`
  **faithfully — it is NOT a placed order** (no `order_id`).
- **D — merchant buyer-input, END-TO-END (gate point 3).** The spend gate APPROVES,
  the merchant answers `requires_buyer_input` (needs a delivery phone) → the adapter
  mints a **typed FormBridge form** → a simulated human fills + submits it in
  FormBridge → FormBridge fires the **signed** answer-back webhook → the adapter
  `update_checkout`s the phone and **re-drives `complete_checkout` through the REAL
  spend gate** → the order completes. The Tier-A AgentLens evidence chain is then
  verified (`verified:true`).

See `transcript.txt` for the captured output of a real run.

## What runs (topology)

| Service            | Port  | What                                                        |
| ------------------ | ----- | ---------------------------------------------------------- |
| Sample merchant    | :3100 | `ucp-samples/rest/nodejs` **+ the committed fork** (`merchant-fork.patch`) |
| AgentGate          | :4000 | `agentkitai/agentgate` server — spend policy + approvals + decision webhooks |
| FormBridge         | :8091 | `agentkitai/formbridge` — typed form handoff for buyer-input (**Scenario D**) |
| The gate           | :8787 | **this repo** — the agentgate-ucp MCP proxy (`npm run dev`) |
| AgentLens          | :3000 | `agentkitai/agentlens` — tamper-evident, hash-chained evidence (**optional**) |

```
buy.ts (MCP client) ──MCP /mcp──▶ gate :8787 ──REST──▶ merchant :3100
                                  │  ▲   │  ▲
                 POST /api/requests│  │   │  └─ POST /intakes + /submissions ─▶ FormBridge :8091
                                  ▼  │   │        signed answer-back (HMAC) ◀── human fills+submits
                            AgentGate :4000 ◀── human taps "Approve"
                            decision webhook (HMAC) ─▶ gate /agentgate/webhook
```

Ports: the sample merchant, AgentGate, and FormBridge all default to :3000, but
**AgentLens owns :3000** in this environment, so the merchant runs on :3100,
AgentGate on :4000, and FormBridge on :8091.

### The FormBridge SSRF workaround (Scenario D)

FormBridge blocks literal `localhost`/`127.0.0.1` webhook-destination URLs (an
SSRF guard with no disable switch). So the gate registers its answer-back webhook
under `PUBLIC_URL=http://lvh.me:8787` — `lvh.me` resolves to `127.0.0.1` via public
DNS, clearing the guard while still reaching the local gate. This needs **outbound
DNS** (no inbound). Offline fallback: a hosts-file entry (e.g. `formbridge.local →
127.0.0.1`) and `PUBLIC_URL=http://formbridge.local:8787`.

## One command

```bash
bash demo/run-demo.sh
```

It applies the merchant fork, starts all four services against **temp SQLite DBs /
in-memory FormBridge**, seeds AgentGate, runs `demo/buy.ts` (all four scenarios),
tees the console to `demo/transcript.txt`, then tears everything down and reverts
the local changes below. Override paths/workdir via env (`MERCHANT_DIR`,
`AGENTGATE_DIR`, `FORMBRIDGE_DIR`, `WORKDIR`, …) — see the top of the script.

## AgentLens evidence (optional)

The gate self-emits a **tamper-evident, hash-chained per-checkout timeline** into
AgentLens (`POST $AGENTLENS_URL/api/events`, one session `ucp_<checkoutId>`):

```
ucp.complete_checkout.received → ucp.gate.decision → ucp.order.parked → ucp.order.replayed
```

The webhook-resume event (`ucp.order.replayed`) chains onto the SAME session as the
original completion, attributed to the same buying agent. Emission is **fail-open**:
a checkout never fails because AgentLens is down or unconfigured.

The runner sets `AGENTLENS_URL=http://localhost:3000` for the gate (override or unset
to disable). Local AgentLens usually runs `AUTH_DISABLED=true`, so no key is needed;
set `AGENTLENS_API_KEY` (an `als_*` key with `write`+`audit` scope) if auth is on.
After Scenario A completes, `buy.ts` independently fetches the **Tier-A** proof:

```
GET $AGENTLENS_URL/api/audit/verify?sessionId=ucp_<checkoutId>
→ ✅ evidence chain verified — 4 events, <firstHash>…<lastHash>
```

Relevant env:

| Var                  | Default                  | Purpose                                        |
| -------------------- | ------------------------ | ---------------------------------------------- |
| `AGENTLENS_URL`      | `http://localhost:3000`  | AgentLens base URL. Unset → evidence disabled. |
| `AGENTLENS_API_KEY`  | (empty)                  | Bearer key; omit when AgentLens is AUTH_DISABLED. |
| `AGENTLENS_AGENT_TOKEN` | (empty)               | AgentGate agent JWT — enables **Tier-B** (see below). |

### Tier-B — signed, verified-agent evidence packs (optional)

Tier-A proves the per-checkout chain is intact. **Tier-B** upgrades that to a
**SIGNED, portable evidence pack** keyed on the *server-verified* agent id, so it
verifies **offline** (away from the AgentLens DB) and is attributable to a real
agent — not a self-reported one.

Two things must be true:

1. **The gate presents an AgentGate agent token on ingest.** Set
   `AGENTLENS_AGENT_TOKEN` to an AgentGate-minted agent JWT (`typ:"agent"`, `sub`
   = the agent id). The gate sends it as `X-Agent-Token` on every `POST
   /api/events`; AgentLens verifies it and stamps `verified_agent_id = sub` into
   each (hashed) event. Without it, events stay unverified and the Tier-B export
   is empty.
2. **The AgentLens server can sign + verify agent tokens.** The server needs:

   | AgentLens server env          | Purpose                                                              |
   | ----------------------------- | -------------------------------------------------------------------- |
   | `AGENTLENS_AUDIT_SIGNING_KEY` | HMAC-SHA256 key — makes `/api/audit/evidence/export` return a **signed** pack and `/verify` return `valid:true` (unset → unsigned pack; `/verify` → HTTP 501). |
   | `AGENTGATE_JWT_SECRET`        | AgentGate's real `JWT_SECRET` — verifies **HS256** agent tokens (shared secret). |
   | `AGENTGATE_JWKS_URL` (or `AGENTGATE_URL`) | Alternative to the shared secret — verifies **RS256** agent tokens against AgentGate's published JWKS (#40), no secret held by AgentLens. |
   | `AGENTGATE_TOKEN_AUDIENCE` / `AGENTGATE_TOKEN_ISSUER` | Optional — when set, enforced on both verify paths (must match what AgentGate mints). |

When enabled, after the four scenarios `buy.ts` runs a **Tier-B beat**: it decodes
the token's `sub`, `POST`s `/api/audit/evidence/export {agentId: sub, from, to,
types:['custom']}`, then `POST`s `/api/audit/evidence/verify` and asserts a signed
pack that verifies offline:

```
🔏 Export a SIGNED evidence pack for the verified buying agent, verify it offline…
   ✅ Tier-B: SIGNED pack for verified agent agt_… — N events, hmac/sha256:… verifies OFFLINE (valid:true)
```

The beat is **best-effort**: unset `AGENTLENS_AGENT_TOKEN`, an unsigned pack (no
signing key), or an unreachable server all **skip cleanly** with a note — Tier-A
still runs. Note the live **:3000** instance (which carries Claude Code telemetry)
has **no** signing key, so Tier-B skips there; point `AGENTLENS_URL` at a
signing-configured AgentLens (with `AGENTGATE_JWT_SECRET` matching the token) to
prove it.

## The merchant fork (a COMMITTED demo fixture)

`merchant-fork.patch` is the committed fork of `ucp-samples/rest/nodejs` this demo
runs against. The runner `git apply`s it before starting the merchant and reverts
it with `git checkout` on exit, so the `ucp-samples` working tree stays clean. It
adds three demo-only, clearly-labelled behaviours:

1. **`$PORT`** honoured (so the merchant runs on :3100; AgentLens owns :3000).
2. **Bulk inventory hold (Scenario C):** any line with `quantity >= 3` completes
   into a NON-buyer-input `requires_escalation` (a `requires_buyer_review` hold with
   a `continue_url`, no field `path`). `3 × pot_ceramic = 4500` stays under the spend
   limit, so the spend gate approves *first*, then the merchant holds — exercising
   the adapter's faithful surfacing (gate point 2).
3. **Buyer-input on `orchid_white` (Scenario D):** completing an `orchid_white`
   checkout without `buyer.phone_number` returns a `requires_buyer_input` escalation
   (with `path: $.buyer.phone_number`); once the phone is supplied via
   `update_checkout`, the re-driven completion places the order. `update_checkout`
   also clears a prior `requires_escalation` hold so the re-drive isn't
   short-circuited by the stale escalation.

(Also, the sample merchant's `better-sqlite3@9` won't build on node-24; a working
`better-sqlite3@11` prebuilt was dropped into its `node_modules` — a local artifact,
not committed.)

## Two local, uncommitted changes (auto-applied + auto-reverted)

The runner also makes two throwaway edits and restores both on exit:

1. **AgentGate `dist/lib/url-validator.js` → an env-gated loopback allowance.**
   AgentGate's webhook SSRF guard blocks `localhost`/`127.0.0.1` (and every
   private LAN IP), so it can't deliver the decision webhook to a local gate. The
   runner injects a guard that returns "valid" **only for loopback and only when
   `AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK=1`** (which it sets only for this run); the
   original file is backed up and restored on exit. This is a local demo-only
   shim — in a real deployment the gate has a routable host and no shim is needed.
2. **FormBridge `dist/`** is rebuilt (`npm run build`) before start — its committed
   `dist/` is gitignored/stale. FormBridge runs with `FORMBRIDGE_AUTH_ENABLED=false`
   and in-memory storage; nothing in its tree is committed by this demo.

## Manual steps (what the runner automates)

```bash
# 1. merchant on :3100 (fork applied from the ucp-samples repo root)
cd ucp-samples && git apply <…>/agentgate-ucp/demo/merchant-fork.patch
cd rest/nodejs && PORT=3100 npx tsx src/index.ts
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

# 5. FormBridge on :8091 (build once — dist is stale — then run, auth off)
cd formbridge && npm run build
PORT=8091 FORMBRIDGE_AUTH_ENABLED=false FORMBRIDGE_STORAGE=memory \
  FORMBRIDGE_WEBHOOK_SECRET=<fb-secret> node dist/server.js
# ready when: curl http://localhost:8091/health

# 6. the gate on :8787 (PUBLIC_URL=lvh.me clears FormBridge's SSRF guard)
cd agentgate-ucp
PORT=8787 PUBLIC_URL=http://lvh.me:8787 \
  MERCHANT_URL=http://localhost:3100 AGENTGATE_URL=http://localhost:4000 \
  AGENTGATE_API_KEY=<agk_…> AGENTGATE_WEBHOOK_SECRET=<secret> \
  AGENTLENS_URL=http://localhost:3000 \
  FORMBRIDGE_URL=http://localhost:8091 FORMBRIDGE_PUBLIC_URL=http://localhost:8091 \
  FORMBRIDGE_WEBHOOK_SECRET=<fb-secret> \
  SQLITE_PATH=<tmp>/gate-parked.db npm run dev
# ready when: curl http://localhost:8787/health

# 7. run the unattended buying agent (all four scenarios)
cd agentgate-ucp
GATE_URL=http://localhost:8787 AGENTGATE_URL=http://localhost:4000 \
  AGENTGATE_API_KEY=<agk_…> AGENTLENS_URL=http://localhost:3000 \
  FORMBRIDGE_URL=http://localhost:8091 npx tsx demo/buy.ts
```

The spend policy seeded in step 4 (global, priority 10):

- `params.checkout.totals_total_minor $gt 5000` → `route_to_human` (park for approval)
- `params.checkout.totals_total_minor $lt 5000` → `auto_approve` (complete immediately)

`buy.ts` products (all except the ×2 roses stay under the spend limit, so the spend
gate approves and the merchant's own escalation is exercised): `bouquet_roses`
**×2 = 7000** trips the gate (A) / **×1 = 3500** auto-approves (B); `pot_ceramic`
**×3 = 4500** is a bulk inventory hold (C); `orchid_white` **×1 = 4500** needs a
buyer phone (D). The human approval in Scenario A is `POST /api/requests/:id/decide`
with the admin key (the AgentGate SDK doesn't expose a decide method), which fires
the `request.approved` webhook. The FormBridge secret in steps 5–6 must match
(it signs / the gate verifies the answer-back webhook).

## Files

| File                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `buy.ts`              | The unattended buying agent (MCP client). Scenarios A–D.       |
| `merchant-fork.patch` | **Committed** merchant fork fixture ($PORT + the C/D escalations). |
| `seed-agentgate.ts`   | Seeds the spend policy + decision webhook via the AgentGate SDK. |
| `mint-admin-key.ts`   | Mints the first AgentGate admin API key straight into its DB.  |
| `run-demo.sh`         | Orchestrator: fork → start (×4) → seed → run → capture → teardown/revert. |
| `transcript.txt`      | Captured output of a real end-to-end run (the evidence).       |

The `demo/` scripts are run with `tsx` and are intentionally OUTSIDE `tsconfig.json`'s
`include` (`src` + `tests` only), so `npm run typecheck` and `npm run test:run`
are unaffected by them.
