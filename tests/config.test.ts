import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

/** A minimal, valid base environment (the required vars). */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    MCP_AUTH_TOKEN: 'mcp-token',
    MERCHANT_URL: 'http://localhost:3100',
    AGENTGATE_URL: 'http://localhost:4000',
    AGENTGATE_API_KEY: 'replace-me',
    AGENTGATE_WEBHOOK_SECRET: 'whsec_agentgate',
  } as NodeJS.ProcessEnv;
}

describe('loadConfig — money-path secrets are REQUIRED (fail-closed)', () => {
  it('THROWS when MCP_AUTH_TOKEN is missing (/mcp must be authenticated)', () => {
    const env = baseEnv();
    delete env['MCP_AUTH_TOKEN'];
    expect(() => loadConfig(env)).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('THROWS when AGENTGATE_WEBHOOK_SECRET is missing (decision webhook re-drives money)', () => {
    const env = baseEnv();
    delete env['AGENTGATE_WEBHOOK_SECRET'];
    expect(() => loadConfig(env)).toThrow(/AGENTGATE_WEBHOOK_SECRET/);
  });

  it('loads with all required vars set', () => {
    const config = loadConfig(baseEnv());
    expect(config.mcpAuthToken).toBe('mcp-token');
    expect(config.agentgateWebhookSecret).toBe('whsec_agentgate');
  });
});

describe('loadConfig — FormBridge fail-closed (finding #7)', () => {
  it('THROWS when FORMBRIDGE_URL is set but FORMBRIDGE_WEBHOOK_SECRET is missing', () => {
    const env = { ...baseEnv(), FORMBRIDGE_URL: 'http://localhost:8091' };
    // The answer-back webhook re-drives a payment; an unauthenticated money
    // endpoint must not be allowed — startup fails closed.
    expect(() => loadConfig(env)).toThrow(/FORMBRIDGE_WEBHOOK_SECRET is required/);
  });

  it('loads when FORMBRIDGE_URL and FORMBRIDGE_WEBHOOK_SECRET are BOTH set', () => {
    const env = {
      ...baseEnv(),
      FORMBRIDGE_URL: 'http://localhost:8091',
      FORMBRIDGE_WEBHOOK_SECRET: 'whsec_formbridge',
    };
    const config = loadConfig(env);
    expect(config.formbridgeUrl).toBe('http://localhost:8091');
    expect(config.formbridgeWebhookSecret).toBe('whsec_formbridge');
  });

  it('loads fine with FORMBRIDGE_URL UNSET (handoff disabled ⇒ no secret needed)', () => {
    const config = loadConfig(baseEnv());
    expect(config.formbridgeUrl).toBeUndefined();
    expect(config.formbridgeWebhookSecret).toBeUndefined();
  });
});
