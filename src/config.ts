/**
 * Runtime configuration, loaded from the environment. See `.env.example`.
 */
export interface Config {
  port: number;
  publicUrl: string;
  merchantUrl: string;
  agentgateUrl: string;
  agentgateApiKey: string;
  /** HMAC secret from AgentGate `createWebhook`, used to verify decision webhooks. */
  agentgateWebhookSecret: string | undefined;
  sqlitePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const must = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };
  return {
    port: Number(env['PORT'] ?? 8787),
    publicUrl: env['PUBLIC_URL'] ?? 'http://localhost:8787',
    merchantUrl: must('MERCHANT_URL'),
    agentgateUrl: must('AGENTGATE_URL'),
    agentgateApiKey: must('AGENTGATE_API_KEY'),
    agentgateWebhookSecret: env['AGENTGATE_WEBHOOK_SECRET'] || undefined,
    sqlitePath: env['SQLITE_PATH'] ?? './agentgate-ucp.db',
  };
}
