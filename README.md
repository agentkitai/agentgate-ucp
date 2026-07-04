# @agentkitai/agentgate-ucp

**The approval gate for unattended UCP buying agents.**

A thin MCP server ("the gate") that a buying agent connects to *instead of* a
merchant's [UCP](https://github.com/Universal-Commerce-Protocol/ucp) checkout
endpoint. It re-exposes the UCP checkout tools 1:1 and passes everything through
— except it runs a **policy/approval gate** before money moves. When a purchase
trips a policy (e.g. total over a threshold), the gate routes it to
[AgentGate](https://github.com/agentkitai/agentgate) for human approval and
resumes the completion out-of-band, so nobody has to be watching the agent.

> UCP's escalation model assumes a human is present at the surface. For
> unattended agents — scheduled replenishment, procurement, background tasks —
> nobody is there. This is the missing approval layer.

## Architecture

```
Buying agent ──MCP──▶ agentgate-ucp ──REST──▶ Merchant UCP checkout
                          │  ▲
             policy check │  │ decision webhook (HMAC)
                          ▼  │
                     AgentGate ──▶ Slack / dashboard (human approves)
```

Gate point 1 (this spine): on `complete_checkout`, the gate reads the merchant's
authoritative totals, evaluates them against AgentGate spend policy, and either
forwards, denies, or **parks** the completion for approval — replaying it with
the original idempotency key once approved.

## Status

Weekend-1 spine, in progress. See `../agentgate-ucp-spine-plan.md`.

## Develop

```bash
npm install
cp .env.example .env   # fill in AGENTGATE_API_KEY etc.
npm run dev            # gate on :8787, MCP at /mcp
npm run typecheck
npm test
```

Local topology: merchant `:3000`, AgentGate `:4000`, gate `:8787`.

MIT.
