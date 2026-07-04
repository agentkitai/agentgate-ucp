import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

/** A minimal, valid base environment (the three required vars). */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    MERCHANT_URL: 'http://localhost:3100',
    AGENTGATE_URL: 'http://localhost:4000',
    AGENTGATE_API_KEY: 'replace-me',
  } as NodeJS.ProcessEnv;
}

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
