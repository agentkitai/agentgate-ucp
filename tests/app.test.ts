import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/app.js';
import type { Gate } from '../src/gate/agentgate.js';
import type { MerchantClient } from '../src/merchant/client.js';
import { openFormPendingStore } from '../src/store/form-pending.js';
import { openParkedStore } from '../src/store/parked.js';

const SECRET = 'whsec_formbridge';

function sign(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Minimal deps; the money handlers are only reached via the routes we exercise. */
function makeDeps(formbridgeWebhookSecret: string | undefined): AppDeps {
  return {
    merchant: { base: 'https://merchant.example' } as unknown as MerchantClient,
    gate: {
      evaluate: () => Promise.resolve({ status: 'approved' as const }),
      continueUrl: (id: string) => `https://gate.example/${id}`,
    } as Gate,
    parked: openParkedStore(':memory:'),
    formPending: openFormPendingStore(':memory:'),
    agentgateWebhookSecret: undefined,
    formbridgeWebhookSecret,
  };
}

describe('createApp — FormBridge webhook fail-closed route gating (finding D)', () => {
  it('does NOT register /formbridge/webhook when no secret is configured ⇒ 404 (route absent)', async () => {
    const app = createApp(makeDeps(undefined));
    const res = await app.request('/formbridge/webhook', {
      method: 'POST',
      body: JSON.stringify({ submissionId: 'sub_x', fields: {} }),
    });
    // The endpoint that re-drives a payment simply does not exist without a secret.
    expect(res.status).toBe(404);
    // /health is always present (sanity: the app itself is wired up).
    expect((await app.request('/health')).status).toBe(200);
  });

  it('registers the route when a secret is set; an UNSIGNED delivery is rejected (401)', async () => {
    const app = createApp(makeDeps(SECRET));
    const res = await app.request('/formbridge/webhook', {
      method: 'POST',
      body: JSON.stringify({ submissionId: 'sub_x', fields: {} }),
      // no X-FormBridge-Signature
    });
    expect(res.status).toBe(401);
  });

  it('registers the route when a secret is set; a correctly-SIGNED delivery is verified (200)', async () => {
    const app = createApp(makeDeps(SECRET));
    const body = JSON.stringify({ submissionId: 'sub_x', fields: {} });
    const res = await app.request('/formbridge/webhook', {
      method: 'POST',
      body,
      headers: { 'X-FormBridge-Signature': sign(body) },
    });
    // Signature verifies (no parked row ⇒ ignored), so the route acks 200 as before.
    expect(res.status).toBe(200);
  });
});
