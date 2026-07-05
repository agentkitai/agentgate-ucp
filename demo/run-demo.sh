#!/usr/bin/env bash
#
# demo/run-demo.sh — bring up the three live services, run the buying agent,
# capture the transcript, and tear everything down.
#
# Topology (see demo/README.md for the why):
#   merchant  :3100   ucp-samples/rest/nodejs (sample UCP merchant, REST)
#   agentgate :4000   agentkitai/agentgate    (policy + approval + webhooks)
#   formbridge:8091   agentkitai/formbridge   (typed form handoff, gate point 3)
#   gate      :8787   THIS repo               (agentgate-ucp MCP proxy)
#
# LOCAL changes applied and REVERTED automatically:
#   1. merchant fork (demo/merchant-fork.patch) → $PORT + two demo-only merchant
#      escalations (bulk inventory hold; orchid_white buyer-input). Applied with
#      `git apply`, reverted with `git checkout` on exit. This is the COMMITTED
#      demo fixture — the merchant source itself is left clean.
#   2. agentgate dist/lib/url-validator.js → an env-GATED loopback allowance so
#      AgentGate can deliver the decision webhook to the local gate. It is inert
#      unless AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK=1 (which we set only here), and
#      the original file is restored from a backup on exit.
#
# FormBridge's SSRF guard blocks literal localhost/127.0.0.1 destination URLs, so
# the gate registers its answer-back webhook under PUBLIC_URL=http://lvh.me:8787
# (lvh.me resolves to 127.0.0.1 via public DNS — needs outbound DNS, no inbound).
#
# Requires: node >=20, npx, git. Run from the agentgate-ucp repo root:
#   bash demo/run-demo.sh
#
set -uo pipefail

# ── Paths (override via env) ────────────────────────────────────────────
ADAPTER_DIR="${ADAPTER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MERCHANT_DIR="${MERCHANT_DIR:-C:/Users/amitp/projects/ucp-samples/rest/nodejs}"
AGENTGATE_DIR="${AGENTGATE_DIR:-C:/Users/amitp/projects/agentkitai/agentgate}"
AGENTGATE_SERVER_DIR="${AGENTGATE_SERVER_DIR:-$AGENTGATE_DIR/packages/server}"
FORMBRIDGE_DIR="${FORMBRIDGE_DIR:-C:/Users/amitp/projects/agentkitai/formbridge}"
WORKDIR="${WORKDIR:-$(mktemp -d)}"
TRANSCRIPT="${TRANSCRIPT:-$ADAPTER_DIR/demo/transcript.txt}"
# node on Windows needs Windows-style ("C:/…") paths, not git-bash "/c/…" ones.
WORKDIR_WIN="$(cygpath -m "$WORKDIR" 2>/dev/null || echo "$WORKDIR")"

# The ucp-samples repo root (the merchant-fork.patch paths are repo-root-relative).
MERCHANT_REPO="$(git -C "$MERCHANT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$MERCHANT_DIR/../..")"
MERCHANT_PATCH="$ADAPTER_DIR/demo/merchant-fork.patch"

MERCHANT_PORT=3100
AGENTGATE_PORT=4000
FORMBRIDGE_PORT=8091
GATE_PORT=8787
# AgentLens (tamper-evident evidence). Optional: unset to run the demo without it.
AGENTLENS_URL="${AGENTLENS_URL:-http://localhost:3000}"
AGENTLENS_API_KEY="${AGENTLENS_API_KEY:-}"
# Shared HMAC secret: FormBridge signs the answer-back webhook, the gate verifies it.
FORMBRIDGE_WEBHOOK_SECRET="${FORMBRIDGE_WEBHOOK_SECRET:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
# lvh.me → 127.0.0.1 (public DNS): the gate's registered webhook URL that clears
# FormBridge's SSRF guard while still reaching the local gate.
GATE_PUBLIC_URL="http://lvh.me:$GATE_PORT"

AGENTGATE_DB="$WORKDIR_WIN/agentgate.db"
GATE_DB="$WORKDIR_WIN/gate-parked.db"
SSRF_FILE="$AGENTGATE_SERVER_DIR/dist/lib/url-validator.js"
SSRF_BAK="$WORKDIR/url-validator.js.demo-bak"

echo "workdir: $WORKDIR"

# ── Teardown ────────────────────────────────────────────────────────────
kill_port() {
  local port="$1"
  # Find LISTENING pid(s) on the port and force-kill the tree (Windows).
  local pids
  pids=$(netstat -ano 2>/dev/null | grep -E "[:.]$port[[:space:]].*LISTENING" | awk '{print $NF}' | sort -u)
  for pid in $pids; do
    [ -n "$pid" ] && taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true
  done
}

# Kill any node.exe whose command line matches a regex (catches tsx-watch parents
# and npx wrappers that a port-kill misses). Careful: scope the regex tightly so
# it never touches unrelated node processes (e.g. AgentLens on :3000).
kill_matching() {
  local regex="$1"
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match '$regex' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1 || true
}

# Track whether THIS run applied the merchant fork, so teardown reverts only what we
# applied — never a blanket `git checkout` that could discard the user's own edits.
MERCHANT_PATCH_APPLIED=0

cleanup() {
  echo ""
  echo "── teardown ──"
  kill_port "$GATE_PORT"
  kill_port "$FORMBRIDGE_PORT"
  kill_port "$AGENTGATE_PORT"
  kill_port "$MERCHANT_PORT"
  # Sweep tsx-watch / npx wrapper orphans by their (tightly-scoped) command line.
  kill_matching 'ucp-samples[\\/]rest[\\/]nodejs'
  kill_matching 'agentgate-ucp[\\/]node_modules[\\/].*tsx'
  kill_matching 'formbridge[\\/]dist[\\/]server'
  # Restore the agentgate SSRF validator.
  [ -f "$SSRF_BAK" ] && cp -f "$SSRF_BAK" "$SSRF_FILE" && echo "restored $SSRF_FILE"
  # Revert ONLY the fork WE applied this run: reverse our own patch hunks (never a
  # blanket `git checkout`, which would silently discard a user's unrelated local
  # edits to the merchant repo). No-op if we didn't apply it (dirty tree / prior run).
  if [ "$MERCHANT_PATCH_APPLIED" = "1" ]; then
    ( cd "$MERCHANT_REPO" \
        && git apply --reverse "$MERCHANT_PATCH" 2>/dev/null \
        && git checkout -- rest/nodejs/databases 2>/dev/null ) \
      && echo "reverted merchant fork (our hunks) + demo dbs"
  fi
  echo "done."
}
trap cleanup EXIT

wait_http() {
  local url="$1" name="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if curl -s -o /dev/null "$url" 2>/dev/null; then echo "  $name ready ($url)"; return 0; fi
    sleep 1
  done
  echo "  ERROR: $name never became ready ($url)"; return 1
}

# ── 1. merchant :3100 ───────────────────────────────────────────────────
# Apply the COMMITTED merchant fork (demo/merchant-fork.patch): honor $PORT plus
# two demo-only merchant escalations. Reverted by the EXIT trap via `git checkout`.
echo "── applying merchant fork (demo/merchant-fork.patch; reverted on exit) ──"
if git -C "$MERCHANT_REPO" apply --reverse --check "$MERCHANT_PATCH" 2>/dev/null; then
  # A prior run already applied it. Leave it EXACTLY as found — we did not apply it
  # this run, so teardown must not revert it (MERCHANT_PATCH_APPLIED stays 0).
  echo "  merchant fork already applied (left as-is on exit)"
elif git -C "$MERCHANT_REPO" apply --check "$MERCHANT_PATCH" 2>/dev/null; then
  git -C "$MERCHANT_REPO" apply "$MERCHANT_PATCH" && MERCHANT_PATCH_APPLIED=1 && echo "  applied merchant-fork.patch"
else
  # The patch neither applies nor reverse-applies cleanly ⇒ the merchant repo has
  # conflicting local edits. Refuse rather than risk clobbering the user's work.
  echo "  ERROR: merchant-fork.patch does not apply cleanly to $MERCHANT_REPO"
  echo "         (uncommitted local edits to the patched files? refusing to touch it.)"; exit 1
fi

echo "── starting sample merchant on :$MERCHANT_PORT ──"
( cd "$MERCHANT_DIR" && PORT=$MERCHANT_PORT npx tsx src/index.ts > "$WORKDIR/merchant.log" 2>&1 ) &
wait_http "http://localhost:$MERCHANT_PORT/.well-known/ucp" merchant || { tail -20 "$WORKDIR/merchant.log"; exit 1; }

# ── 2. mint admin key (server DOWN) ─────────────────────────────────────
echo "── minting AgentGate admin key ──"
ADMIN_KEY=$(cd "$ADAPTER_DIR" && AGENTGATE_SERVER_DIR="$AGENTGATE_SERVER_DIR" DATABASE_URL="$AGENTGATE_DB" npx tsx demo/mint-admin-key.ts)
if [ -z "$ADMIN_KEY" ]; then echo "ERROR: failed to mint admin key"; exit 1; fi
echo "  admin key: ${ADMIN_KEY:0:12}…"

# ── 3. patch SSRF validator (env-gated, reverted on exit) ───────────────
echo "── patching agentgate SSRF validator (env-gated loopback allowance) ──"
cp -f "$SSRF_FILE" "$SSRF_BAK"
node -e '
  const fs=require("fs"); const f=process.argv[1];
  let s=fs.readFileSync(f,"utf8");
  const needle="export async function validateWebhookUrl(url) {";
  const guard=needle+"\n    if (process.env.AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK === \x27\x31\x27) { try { const __u = new URL(url); if (__u.hostname === \x27localhost\x27 || __u.hostname === \x27127.0.0.1\x27 || __u.hostname === \x27::1\x27) { return { valid: true, resolvedIP: \x27127.0.0.1\x27 }; } } catch (e) {} }";
  if (!s.includes("AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK")) { s=s.replace(needle,guard); fs.writeFileSync(f,s); console.log("  patched validateWebhookUrl (loopback allowed when env flag set)"); }
  else { console.log("  already patched"); }
' "$SSRF_FILE"

# ── 4. start agentgate :4000 ────────────────────────────────────────────
echo "── starting AgentGate on :$AGENTGATE_PORT ──"
( cd "$AGENTGATE_DIR" && \
  PORT=$AGENTGATE_PORT \
  NODE_ENV=development \
  AUTH_MODE=api-key-only \
  DB_DIALECT=sqlite \
  DATABASE_URL="$AGENTGATE_DB" \
  RATE_LIMIT_ENABLED=false \
  LOG_LEVEL=info \
  AGENTGATE_UCP_DEMO_ALLOW_LOOPBACK=1 \
  node packages/server/dist/index.js > "$WORKDIR/agentgate.log" 2>&1 ) &
wait_http "http://localhost:$AGENTGATE_PORT/health" agentgate || { tail -20 "$WORKDIR/agentgate.log"; exit 1; }

echo "── seeding AgentGate (policy + webhook) ──"
SEED=$(cd "$ADAPTER_DIR" && \
  AGENTGATE_URL="http://localhost:$AGENTGATE_PORT" \
  AGENTGATE_API_KEY="$ADMIN_KEY" \
  GATE_WEBHOOK_URL="http://localhost:$GATE_PORT/agentgate/webhook" \
  npx tsx demo/seed-agentgate.ts)
WEBHOOK_SECRET=$(echo "$SEED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.trim().split("\n").pop()).webhookSecret))')
if [ -z "$WEBHOOK_SECRET" ]; then echo "ERROR: failed to seed / capture webhook secret"; exit 1; fi
echo "  webhook secret: ${WEBHOOK_SECRET:0:8}…"

# ── 4. FormBridge :8091 (typed form handoff, gate point 3) ──────────────
# Build once (its committed dist/ is stale) then run against in-memory storage,
# auth OFF, signing with the shared FORMBRIDGE_WEBHOOK_SECRET.
echo "── building + starting FormBridge on :$FORMBRIDGE_PORT ──"
( cd "$FORMBRIDGE_DIR" && npm run build > "$WORKDIR/formbridge-build.log" 2>&1 ) \
  || { echo "  ERROR: FormBridge build failed"; tail -20 "$WORKDIR/formbridge-build.log"; exit 1; }
( cd "$FORMBRIDGE_DIR" && \
  PORT=$FORMBRIDGE_PORT \
  FORMBRIDGE_AUTH_ENABLED=false \
  FORMBRIDGE_STORAGE=memory \
  FORMBRIDGE_WEBHOOK_SECRET="$FORMBRIDGE_WEBHOOK_SECRET" \
  node dist/server.js > "$WORKDIR/formbridge.log" 2>&1 ) &
wait_http "http://localhost:$FORMBRIDGE_PORT/health" formbridge || { tail -20 "$WORKDIR/formbridge.log"; exit 1; }

# ── 5. gate :8787 ───────────────────────────────────────────────────────
# PUBLIC_URL uses lvh.me (→127.0.0.1) so the answer-back webhook URL the gate
# registers with FormBridge clears FormBridge's SSRF guard yet reaches the gate.
echo "── starting the gate on :$GATE_PORT ──"
( cd "$ADAPTER_DIR" && \
  PORT=$GATE_PORT \
  PUBLIC_URL="$GATE_PUBLIC_URL" \
  MERCHANT_URL="http://localhost:$MERCHANT_PORT" \
  AGENTGATE_URL="http://localhost:$AGENTGATE_PORT" \
  AGENTGATE_API_KEY="$ADMIN_KEY" \
  AGENTGATE_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
  SQLITE_PATH="$GATE_DB" \
  AGENTLENS_URL="$AGENTLENS_URL" \
  AGENTLENS_API_KEY="$AGENTLENS_API_KEY" \
  FORMBRIDGE_URL="http://localhost:$FORMBRIDGE_PORT" \
  FORMBRIDGE_PUBLIC_URL="http://localhost:$FORMBRIDGE_PORT" \
  FORMBRIDGE_WEBHOOK_SECRET="$FORMBRIDGE_WEBHOOK_SECRET" \
  npm run dev > "$WORKDIR/gate.log" 2>&1 ) &
wait_http "http://localhost:$GATE_PORT/health" gate || { tail -20 "$WORKDIR/gate.log"; exit 1; }

# ── 6. run the buying agent, capture the transcript ─────────────────────
echo "── running demo/buy.ts (transcript → $TRANSCRIPT) ──"
( cd "$ADAPTER_DIR" && \
  GATE_URL="http://localhost:$GATE_PORT" \
  AGENTGATE_URL="http://localhost:$AGENTGATE_PORT" \
  AGENTGATE_API_KEY="$ADMIN_KEY" \
  AGENTLENS_URL="$AGENTLENS_URL" \
  AGENTLENS_API_KEY="$AGENTLENS_API_KEY" \
  FORMBRIDGE_URL="http://localhost:$FORMBRIDGE_PORT" \
  npx tsx demo/buy.ts ) 2>&1 | tee "$TRANSCRIPT"
STATUS=${PIPESTATUS[0]}

echo ""
echo "buy.ts exit status: $STATUS"
exit "$STATUS"
