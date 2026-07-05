# @agentkitai/agentgate-ucp

**The approval gate for unattended UCP buying agents.**

![A gated purchase, animated — an unattended agent places an order, the gate parks it over budget, a human approves at their computer, and it completes with a verifiable evidence trail.](docs/agentgate-ucp-demo.gif)

**▶ [Play the interactive walkthrough](https://agentkitai.github.io/agentgate-ucp/flow.html)** &nbsp;·&nbsp; [read the launch post](https://agentkitai.github.io/agentgate-ucp/)

A thin MCP server ("the gate") that a buying agent connects to *instead of* a
merchant's [UCP](https://github.com/universal-commerce-protocol) checkout
endpoint. It re-exposes the UCP checkout tools 1:1 and passes everything through
— except it runs a **policy / approval / evidence** layer before money moves.

> UCP's escalation model assumes a human is present at the surface. For
> **unattended** agents — scheduled replenishment, procurement, background jobs —
> nobody is watching. This is the missing approval layer, plus a tamper-evident
> record of every gated purchase.

The agent still speaks plain UCP. It never learns there's a gate in front of the
merchant; it just sometimes gets an escalation back (with a link a human
resolves) instead of a completed order.

## What it does — three gate points

The five checkout tools (`create` / `get` / `update` / `complete` / `cancel_checkout`)
pass straight through to the merchant. Three seams add control:

**① Spend policy** — on `complete_checkout`, the gate fetches the merchant's
**authoritative** totals (never the agent-supplied amount), evaluates them
against [AgentGate](https://github.com/agentkitai/agentgate) spend policy, and
either forwards, denies, or **parks** the completion. A parked purchase waits
for a human's approval (Slack / dashboard) and is replayed out-of-band — with
the **original idempotency key** — the moment they approve.

**② Merchant escalations** — when the merchant itself answers a completion with
a `requires_escalation` (an inventory hold, a fraud review), the gate surfaces
it **faithfully** to the agent — never misreporting a held order as placed.

**③ Buyer-input form handoff** — when the merchant needs a field only a human
can supply (`requires_buyer_input`), the gate resolves the **real UCP field
schema** at that JSONPath, builds a **typed** [FormBridge](https://github.com/agentkitai/formbridge)
form, and hands back a resume link. The human fills it; the gate writes the
answer back to its exact path, `update_checkout`s, and re-drives completion
**through the spend gate again**.

## Evidence — every gated purchase is provable

The gate self-emits a hash-chained timeline of each purchase into
[AgentLens](https://github.com/agentkitai/agentlens), keyed one session per
checkout (`received → decision → parked → approved/replayed → placed`).

- **Tier A** works with any AgentLens: `GET /api/audit/verify?sessionId=ucp_<checkout>`
  proves the chain is intact (`verified:true, brokenChains:[]`).
- **Tier B** (AgentLens configured with a signing key + agent-token verification):
  a **signed, portable, offline-verifiable** `agentlens.evidence-pack/v1` keyed on
  a server-derived `verified_agent_id` — dispute-grade proof that *this agent*
  made *this purchase*, checkable without the database.

## Architecture

```
Buying agent ──MCP──▶  agentgate-ucp  ──REST──▶  Merchant UCP checkout
                          │   ▲   │
            spend policy  │   │   └───emit───▶  AgentLens   (hash-chained evidence)
                          ▼   │
                     AgentGate  ──▶ Slack / dashboard   (human approves)
                          │
                    decision webhook (HMAC) ──▶ gate replays the parked completion

   requires_buyer_input ──▶ FormBridge (typed form) ──▶ human ──▶ answer-back
                            webhook (HMAC) ──▶ gate writes answer, re-drives complete
```

## Try it — the live demo

`demo/run-demo.sh` stands up all five services locally and drives four scenarios
end to end, capturing a transcript:

| | Scenario | Proves |
|---|---|---|
| A | over-spend | parked → human approves in AgentGate → decision webhook → replayed → completed |
| B | under-spend | auto-approved, completes immediately |
| C | merchant hold | a merchant `requires_escalation` surfaced faithfully (no order placed) |
| D | buyer-input | typed FormBridge form → human fills → answer-back → re-drive → completed, with a verified AgentLens chain |

```bash
bash demo/run-demo.sh   # merchant :3100, agentgate :4000, formbridge :8091, gate :8787
```

See [`demo/README.md`](demo/README.md) for the topology and the recorded
[`demo/transcript.txt`](demo/transcript.txt).

## Security posture

- **Authoritative amounts.** The spend gate reads totals from the merchant, never
  from the agent-supplied object; a buyer's form answer that changes the total is
  re-gated on the re-drive.
- **Fail-closed webhooks.** The AgentGate and FormBridge webhooks are HMAC-verified
  over the raw body; the answer-back route (which re-drives a payment) is *only
  registered when a webhook secret is set* — no unsigned re-drive is possible.
- **At-least-once + tamper safe.** Parked completions replay the stored snapshot
  with the pinned idempotency key, not the webhook's params.
- **Hardened JSONPath.** Buyer-input answers write to exactly one concrete
  location; `__proto__`/`constructor`/`prototype` and wildcard/filter/negative-index
  paths are rejected (no prototype pollution, no fan-out).
- **Crash-recoverable.** Parked forms use a lease so a mid-flight crash can never
  strand an answered order.

Hardened by two independent adversarial reviews (a multi-lens workflow + Codex
gpt-5.5) — 30+ findings fixed before release, each with a regression test.

## Develop

```bash
npm install
cp .env.example .env     # MERCHANT_URL / AGENTGATE_URL / AGENTGATE_API_KEY required; the rest optional
npm run dev              # gate on :8787, MCP at /mcp
npm run typecheck
npm test                 # 132 tests
npm run build && node dist/index.js
```

Local topology: merchant `:3100`, AgentGate `:4000`, FormBridge `:8091`,
AgentLens `:3000`, gate `:8787`. Every integration (AgentGate aside) is optional
— unset its URL and that seam passes through untouched.

## Status

Gate points 1–3 + evidence complete and demo-verified end to end. Targets the
merged UCP checkout surface (`requires_escalation` + `messages[]` + `continue_url`);
tracking the in-flight Actions primitive ([UCP #553](https://github.com/universal-commerce-protocol)).

MIT.
