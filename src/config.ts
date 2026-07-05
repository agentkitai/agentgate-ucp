/**
 * Runtime configuration, loaded from the environment. See `.env.example`.
 */
export interface Config {
  port: number;
  publicUrl: string;
  /**
   * Bearer token every buying agent must present on `/mcp` (Authorization: Bearer
   * <token>). REQUIRED — `/mcp` drives real purchases, so an unauthenticated
   * endpoint is a policy bypass. The gate refuses to start without it.
   */
  mcpAuthToken: string;
  merchantUrl: string;
  agentgateUrl: string;
  agentgateApiKey: string;
  /**
   * HMAC secret from AgentGate `createWebhook`, used to verify decision webhooks.
   * REQUIRED: the decision webhook re-drives a parked (over-policy) completion, so
   * an unsigned delivery must never be accepted — the gate fails to start without it.
   */
  agentgateWebhookSecret: string;
  sqlitePath: string;
  /** AgentLens base URL for tamper-evident evidence (AGENTLENS_URL). Unset → no evidence. */
  agentlensUrl: string | undefined;
  /** AgentLens Bearer key (AGENTLENS_API_KEY). Omit when AgentLens runs AUTH_DISABLED. */
  agentlensApiKey: string | undefined;
  /** AgentGate agent token (AGENTLENS_AGENT_TOKEN) for verified-agent evidence packs. */
  agentlensAgentToken: string | undefined;
  /**
   * FormBridge base URL (FORMBRIDGE_URL) — the typed form-handoff service for
   * `requires_buyer_input` escalations (gate point 3). UNSET ⇒ buyer-input is
   * returned as the RAW UCP escalation, no form handoff (unchanged behaviour).
   */
  formbridgeUrl: string | undefined;
  /** Public FormBridge URL humans reach (FORMBRIDGE_PUBLIC_URL). Defaults to formbridgeUrl. */
  formbridgePublicUrl: string | undefined;
  /** FormBridge Bearer key (FORMBRIDGE_API_KEY). Omit when FormBridge runs auth-disabled. */
  formbridgeApiKey: string | undefined;
  /** HMAC secret (FORMBRIDGE_WEBHOOK_SECRET) verifying FormBridge → adapter answer-back webhooks. */
  formbridgeWebhookSecret: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const must = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };
  const config: Config = {
    port: Number(env['PORT'] ?? 8787),
    publicUrl: env['PUBLIC_URL'] ?? 'http://localhost:8787',
    // Fail CLOSED: /mcp moves money, so it MUST be authenticated. No default.
    mcpAuthToken: must('MCP_AUTH_TOKEN'),
    merchantUrl: must('MERCHANT_URL'),
    agentgateUrl: must('AGENTGATE_URL'),
    agentgateApiKey: must('AGENTGATE_API_KEY'),
    // Fail CLOSED: the decision webhook re-drives a real payment (see the throw below).
    agentgateWebhookSecret: must('AGENTGATE_WEBHOOK_SECRET'),
    sqlitePath: env['SQLITE_PATH'] ?? './agentgate-ucp.db',
    // AgentLens evidence is entirely optional — the adapter runs fine without it.
    agentlensUrl: env['AGENTLENS_URL'] || undefined,
    agentlensApiKey: env['AGENTLENS_API_KEY'] || undefined,
    agentlensAgentToken: env['AGENTLENS_AGENT_TOKEN'] || undefined,
    // FormBridge form-handoff (gate point 3) is entirely optional — unset
    // FORMBRIDGE_URL and buyer-input escalations pass through untouched.
    formbridgeUrl: env['FORMBRIDGE_URL'] || undefined,
    formbridgePublicUrl: env['FORMBRIDGE_PUBLIC_URL'] || env['FORMBRIDGE_URL'] || undefined,
    formbridgeApiKey: env['FORMBRIDGE_API_KEY'] || undefined,
    formbridgeWebhookSecret: env['FORMBRIDGE_WEBHOOK_SECRET'] || undefined,
  };

  // Fail CLOSED: the answer-back webhook re-drives a real completion (moves money),
  // so it MUST be authenticated. When the handoff is enabled (FORMBRIDGE_URL set)
  // a webhook secret is mandatory — refuse to start otherwise rather than accept
  // unsigned writes to a money endpoint.
  if (config.formbridgeUrl && !config.formbridgeWebhookSecret) {
    throw new Error(
      'FORMBRIDGE_WEBHOOK_SECRET is required when FORMBRIDGE_URL is set: the FormBridge answer-back ' +
        'webhook re-drives a payment and must be HMAC-authenticated (fail-closed).'
    );
  }

  return config;
}
