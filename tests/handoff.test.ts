import { describe, expect, it } from 'vitest';

import type {
  CreatedSubmission,
  FormBridgeActor,
  FormBridgeClient,
  FormBridgeIntakeDefinition,
} from '../src/formbridge/client.js';
import type { Gate } from '../src/gate/agentgate.js';
import { gateCompleteCheckout } from '../src/gate/complete.js';
import type { HandoffContext, HandoffDeps } from '../src/handoff/run.js';
import { maybeHandoffBuyerInput } from '../src/handoff/run.js';
import { dispatchToolCall } from '../src/mapping.js';
import { MerchantClient } from '../src/merchant/client.js';
import type { EvidenceRecorder } from '../src/observability/agentlens.js';
import type { JSONSchema } from '../src/schema/json-schema.js';
import { openFormPendingStore } from '../src/store/form-pending.js';
import type { Checkout } from '../src/types.js';

interface CreateCall {
  intakeId: string;
  opts: { actor: FormBridgeActor; initialFields?: Record<string, unknown>; idempotencyKey?: string };
}

/** Recording stub FormBridge client. */
function makeStubFbClient(): {
  fbClient: FormBridgeClient;
  intakes: FormBridgeIntakeDefinition[];
  submissions: CreateCall[];
} {
  const intakes: FormBridgeIntakeDefinition[] = [];
  const submissions: CreateCall[] = [];
  const stub = {
    registerIntake(def: FormBridgeIntakeDefinition): Promise<void> {
      intakes.push(def);
      return Promise.resolve();
    },
    createSubmission(
      intakeId: string,
      opts: { actor: FormBridgeActor; initialFields?: Record<string, unknown>; idempotencyKey?: string }
    ): Promise<CreatedSubmission> {
      submissions.push({ intakeId, opts });
      return Promise.resolve({ submissionId: 'sub_1', resumeToken: 'rt_abc123' });
    },
  };
  return { fbClient: stub as unknown as FormBridgeClient, intakes, submissions };
}

const BUYER_INPUT_CHECKOUT: Checkout = {
  id: 'co_42',
  status: 'requires_escalation',
  messages: [
    {
      type: 'error',
      code: 'buyer_input_required',
      severity: 'requires_buyer_input',
      path: '$.buyer.phone_number',
      content: 'A contact phone number is required.',
    },
  ],
};

const CTX: HandoffContext = {
  checkoutId: 'co_42',
  merchantBaseUrl: 'https://merchant.example',
  agentId: 'https://platform.example/agent.json',
  ucpAgent: 'profile="https://platform.example/agent.json"',
  paymentPayload: { payment_data: { handler_id: 'mock_payment_handler' } },
  idempotencyKey: 'idem-1',
};

function deps(fbClient: FormBridgeClient): HandoffDeps {
  return {
    fbClient,
    formPending: openFormPendingStore(':memory:'),
    formbridgePublicUrl: 'https://fb.example',
    adapterWebhookUrl: 'https://adapter.example/formbridge/webhook',
  };
}

describe('maybeHandoffBuyerInput — buyer-input escalation', () => {
  it('registers a TYPED intake (real field type, NOT an additionalProperties blob), parks a row, returns the resume escalation', async () => {
    const { fbClient, intakes, submissions } = makeStubFbClient();
    const d = deps(fbClient);

    const result = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d);

    // 1. A single TYPED intake was registered.
    expect(intakes).toHaveLength(1);
    const intake = intakes[0]!;
    expect(intake.id).toBe('ucp-buyer-input-co_42');
    expect(intake.destination).toEqual({
      kind: 'webhook',
      url: 'https://adapter.example/formbridge/webhook',
    });
    // No approvalGates are part of the definition — an ungated submit fires the webhook.
    expect((intake as unknown as Record<string, unknown>)['approvalGates']).toBeUndefined();

    const schema = intake.schema;
    expect(schema.type).toBe('object');
    // The composed schema is TYPED + closed — not a generic passthrough blob.
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties ?? {};
    expect(Object.keys(props)).toEqual(['buyer__phone_number']);
    const field = props['buyer__phone_number'] as JSONSchema;
    expect(field.type).toBe('string'); // the REAL resolved UCP field type
    expect(field).not.toHaveProperty('$ref');
    expect(field).not.toHaveProperty('allOf');
    expect(schema.required).toEqual(['buyer__phone_number']);

    // 2. A submission was created for that intake, attributed to the agent.
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.intakeId).toBe('ucp-buyer-input-co_42');
    expect(submissions[0]!.opts.actor.kind).toBe('agent');

    // 3. A form-pending row was parked, keyed by the submission id.
    const row = d.formPending.get('sub_1');
    expect(row).toBeDefined();
    expect(row?.checkoutId).toBe('co_42');
    expect(row?.merchantBaseUrl).toBe('https://merchant.example');
    expect(row?.idempotencyKey).toBe('idem-1');
    expect(row?.fieldMap).toEqual({ buyer__phone_number: '$.buyer.phone_number' });
    expect(row?.paymentPayload).toEqual({ payment_data: { handler_id: 'mock_payment_handler' } });
    expect(row?.status).toBe('pending');

    // 4. The result is a UCP escalation whose continue_url is the resume link.
    expect(result.status).toBe('requires_escalation');
    expect(result.continue_url).toBe('https://fb.example/resume?token=rt_abc123');
    expect(result.messages?.[0]?.severity).toBe('requires_buyer_input');
  });

  it('prefills an agent-known value at the path into the submission', async () => {
    const { fbClient, submissions } = makeStubFbClient();
    const known: Checkout = {
      ...BUYER_INPUT_CHECKOUT,
      buyer: { phone_number: '+15550000000' },
    };
    await maybeHandoffBuyerInput(known, CTX, deps(fbClient));
    expect(submissions[0]!.opts.initialFields).toEqual({ buyer__phone_number: '+15550000000' });
  });

  it('passes FormBridge a stable idempotency-key + resume URL is the form-renderer page (?token=)', async () => {
    const { fbClient, submissions } = makeStubFbClient();
    const result = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, deps(fbClient));
    // A stable idempotency-key is derived from checkout + fields so FormBridge dedups.
    expect(typeof submissions[0]!.opts.idempotencyKey).toBe('string');
    expect(submissions[0]!.opts.idempotencyKey!.length).toBeGreaterThan(0);
    // Resume URL is the FORM-RENDERER page (query-param token), not the JSON API.
    expect(result.continue_url).toBe('https://fb.example/resume?token=rt_abc123');
    expect(result.continue_url).not.toContain('/submissions/resume/');
  });

  it('IDEMPOTENT: two handoffs for one still-pending checkout ⇒ ONE submission, ONE row, same continue_url', async () => {
    const { fbClient, intakes, submissions } = makeStubFbClient();
    const d = deps(fbClient);

    const first = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d);
    // A second detect (e.g. a get_checkout poll) must REUSE the pending form.
    const second = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d);

    expect(submissions).toHaveLength(1); // no second submission minted
    expect(intakes).toHaveLength(1);
    expect(first.continue_url).toBe('https://fb.example/resume?token=rt_abc123');
    expect(second.continue_url).toBe(first.continue_url); // one stable continue_url
    // Exactly one pending row for the checkout.
    expect(d.formPending.getByCheckoutId('co_42')?.submissionId).toBe('sub_1');
  });
});

describe('maybeHandoffBuyerInput — status-aware reuse (finding C)', () => {
  it('a PROCESSING row is reused (in-flight URL) and NOT clobbered back to pending', async () => {
    const { fbClient, submissions } = makeStubFbClient();
    const d = deps(fbClient);

    // First handoff → pending row sub_1; an answer-back then claims it → processing.
    await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d);
    expect(d.formPending.claim('sub_1')).toBe(true);
    expect(d.formPending.get('sub_1')?.status).toBe('processing');

    // A concurrent poll re-detects the escalation: reuse the in-flight URL, do NOT
    // mint a new submission and do NOT reset the processing row to pending.
    const result = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d);
    expect(result.continue_url).toBe('https://fb.example/resume?token=rt_abc123');
    expect(submissions).toHaveLength(1); // no second submission minted
    expect(d.formPending.get('sub_1')?.status).toBe('processing'); // NOT resurrected
  });

  it('a TERMINAL (resolved) row is NOT resurrected — returns the raw escalation, no new row', async () => {
    const { fbClient, submissions } = makeStubFbClient();
    const d = deps(fbClient);

    await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d); // pending sub_1
    d.formPending.markStatus('sub_1', 'resolved');

    const result = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, d);
    expect(result).toBe(BUYER_INPUT_CHECKOUT); // raw escalation, no form
    expect(submissions).toHaveLength(1); // no new submission
    expect(d.formPending.get('sub_1')?.status).toBe('resolved'); // still terminal
  });

  it('complete-after-get UPGRADES a payload-less pending row with the completion payload + key', async () => {
    const { fbClient, submissions } = makeStubFbClient();
    const d = deps(fbClient);

    // A get_checkout handoff parks a pending row with NO payment payload.
    await maybeHandoffBuyerInput(
      BUYER_INPUT_CHECKOUT,
      { ...CTX, paymentPayload: null, idempotencyKey: 'idem-get' },
      d
    );
    expect(d.formPending.get('sub_1')?.paymentPayload).toBeNull();

    // A later complete_checkout for the SAME checkout reuses the row AND upgrades it
    // with the real payment payload + pinned key so answer-back can re-drive the order.
    const PAY = { payment_data: { handler_id: 'mock_payment_handler' } };
    await maybeHandoffBuyerInput(
      BUYER_INPUT_CHECKOUT,
      { ...CTX, paymentPayload: PAY, idempotencyKey: 'idem-complete' },
      d
    );

    expect(submissions).toHaveLength(1); // reused, not a new submission
    const row = d.formPending.get('sub_1');
    expect(row?.paymentPayload).toEqual(PAY);
    expect(row?.idempotencyKey).toBe('idem-complete');
    expect(row?.status).toBe('pending');
  });
});

describe('maybeHandoffBuyerInput — path policy degrades to the RAW escalation', () => {
  /** A buyer-input checkout whose single message points at `path`. */
  function checkoutWithPath(path: string): Checkout {
    return {
      id: 'co_42',
      status: 'requires_escalation',
      messages: [
        {
          type: 'error',
          code: 'buyer_input_required',
          severity: 'requires_buyer_input',
          path,
          content: 'Field required.',
        },
      ],
    };
  }

  it('unmappable path ($.buyer.not_a_real_field) ⇒ raw escalation, NO intake registered', async () => {
    const { fbClient, intakes, submissions } = makeStubFbClient();
    const co = checkoutWithPath('$.buyer.not_a_real_field');
    const result = await maybeHandoffBuyerInput(co, CTX, deps(fbClient));
    expect(result).toBe(co); // unchanged — raw escalation
    expect(intakes).toHaveLength(0);
    expect(submissions).toHaveLength(0);
  });

  it('prototype-pollution path (__proto__) ⇒ raw escalation, NO submission, Object.prototype UNTOUCHED', async () => {
    const { fbClient, intakes, submissions } = makeStubFbClient();
    const co = checkoutWithPath('$.buyer.__proto__.polluted');
    const result = await maybeHandoffBuyerInput(co, CTX, deps(fbClient));
    expect(result).toBe(co);
    expect(intakes).toHaveLength(0);
    expect(submissions).toHaveLength(0);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('non-singular (wildcard) and NEGATIVE-index paths ⇒ raw escalation, no fan-out', async () => {
    for (const path of ['$.line_items[*].id', '$.line_items[-1].id']) {
      const { fbClient, intakes, submissions } = makeStubFbClient();
      const co = checkoutWithPath(path);
      const result = await maybeHandoffBuyerInput(co, CTX, deps(fbClient));
      expect(result).toBe(co);
      expect(intakes).toHaveLength(0);
      expect(submissions).toHaveLength(0);
    }
  });
});

describe('maybeHandoffBuyerInput — fail-safe', () => {
  it('returns the RAW escalation unchanged when handoff is not configured (FORMBRIDGE_URL unset)', async () => {
    const result = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, undefined);
    expect(result).toBe(BUYER_INPUT_CHECKOUT);
  });

  it('is a no-op for a non-buyer-input checkout', async () => {
    const { fbClient, intakes } = makeStubFbClient();
    const completed: Checkout = { id: 'co_9', status: 'completed' };
    const result = await maybeHandoffBuyerInput(completed, { ...CTX, checkoutId: 'co_9' }, deps(fbClient));
    expect(result).toBe(completed);
    expect(intakes).toHaveLength(0);
  });

  it('degrades to the raw escalation (never throws) when FormBridge errors', async () => {
    const throwing = {
      registerIntake(): Promise<void> {
        return Promise.reject(new Error('formbridge down'));
      },
      createSubmission(): Promise<CreatedSubmission> {
        return Promise.resolve({ submissionId: 'x', resumeToken: 'y' });
      },
    } as unknown as FormBridgeClient;

    const result = await maybeHandoffBuyerInput(BUYER_INPUT_CHECKOUT, CTX, deps(throwing));
    expect(result).toBe(BUYER_INPUT_CHECKOUT);
  });
});

/**
 * The gate integration: an approved completion whose merchant answer is a
 * buyer-input escalation must be diverted to a typed handoff (parking the
 * ORIGINAL payment payload so the answer-back can re-drive it), and — critically
 * — with FORMBRIDGE_URL unset it stays the raw escalation (the 53-test contract).
 */
describe('gateCompleteCheckout — buyer-input handoff wiring', () => {
  const AGENT_META = {
    'ucp-agent': { profile: 'https://platform.example/agent.json' },
    'idempotency-key': 'key-abc',
  };
  const PAYMENT = { payment_data: { handler_id: 'mock_payment_handler' } };

  /** GET is ready_for_complete; complete answers with a buyer-input escalation. */
  function makeBuyerInputMerchant(): MerchantClient {
    const authoritative: Checkout = {
      id: 'co_42',
      status: 'ready_for_complete',
      currency: 'USD',
      line_items: [{ id: 'line_1', quantity: 1, item: { id: 'prod_1' } }],
      totals: [{ type: 'total', amount: 1000 }],
    };
    const stub = {
      base: 'https://merchant.example',
      getCheckout: () => Promise.resolve(authoritative),
      completeCheckout: () =>
        Promise.resolve<Checkout>({
          id: 'co_42',
          status: 'requires_escalation',
          messages: [
            {
              type: 'error',
              code: 'buyer_input_required',
              severity: 'requires_buyer_input',
              path: '$.buyer.phone_number',
              content: 'A contact phone number is required.',
            },
          ],
        }),
    };
    return stub as unknown as MerchantClient;
  }

  const approvingGate: Gate = {
    evaluate: () => Promise.resolve({ status: 'approved' as const }),
    continueUrl: (id: string) => `https://gate.example/requests/${id}`,
  };

  it('diverts an approved-but-buyer-input completion to a typed form + parks the payment payload for re-drive', async () => {
    const { fbClient } = makeStubFbClient();
    const d = deps(fbClient);
    const res = await gateCompleteCheckout(
      makeBuyerInputMerchant(),
      approvingGate,
      { meta: AGENT_META, id: 'co_42', checkout: PAYMENT },
      {},
      undefined,
      undefined,
      d
    );

    const sc = res.structuredContent as Checkout;
    expect(sc.status).toBe('requires_escalation');
    expect(sc.continue_url).toBe('https://fb.example/resume?token=rt_abc123');
    expect(sc.messages?.[0]?.severity).toBe('requires_buyer_input');

    // The parked row carries the ORIGINAL payment payload + pinned key for the re-drive.
    const row = d.formPending.get('sub_1');
    expect(row?.checkoutId).toBe('co_42');
    expect(row?.paymentPayload).toEqual(PAYMENT);
    expect(row?.idempotencyKey).toBe('key-abc');
    expect(row?.status).toBe('pending');
  });

  it('NO-GATE complete_checkout (passthrough) parks the ACTUAL payment payload for re-drive (finding F)', async () => {
    // In no-gate server mode complete_checkout flows through dispatchToolCall, not the
    // gate. A buyer-input on it must still park the real payment payload so answer-back
    // can re-drive — parking null (as the other four tools do) would strand the order.
    const buyerInput: Checkout = {
      id: 'co_42',
      status: 'requires_escalation',
      messages: [
        {
          type: 'error',
          code: 'buyer_input_required',
          severity: 'requires_buyer_input',
          path: '$.buyer.phone_number',
          content: 'A contact phone number is required.',
        },
      ],
    };
    const merchant = {
      base: 'https://merchant.example',
      completeCheckout: () => Promise.resolve(buyerInput),
    } as unknown as MerchantClient;

    const { fbClient } = makeStubFbClient();
    const d = deps(fbClient);
    const PAY = { payment_data: { handler_id: 'mock_payment_handler' } };

    await dispatchToolCall(
      merchant,
      'complete_checkout',
      { meta: AGENT_META, id: 'co_42', checkout: PAY },
      d
    );

    const row = d.formPending.get('sub_1');
    expect(row?.paymentPayload).toEqual(PAY); // NOT null
    expect(row?.idempotencyKey).toBe('key-abc'); // the pinned completion key
  });

  it('a NON-complete passthrough (get_checkout) still parks NO payload (null)', async () => {
    const buyerInput: Checkout = {
      id: 'co_42',
      status: 'requires_escalation',
      messages: [
        {
          type: 'error',
          code: 'buyer_input_required',
          severity: 'requires_buyer_input',
          path: '$.buyer.phone_number',
          content: 'A contact phone number is required.',
        },
      ],
    };
    const merchant = {
      base: 'https://merchant.example',
      getCheckout: () => Promise.resolve(buyerInput),
    } as unknown as MerchantClient;

    const { fbClient } = makeStubFbClient();
    const d = deps(fbClient);
    await dispatchToolCall(merchant, 'get_checkout', { meta: AGENT_META, id: 'co_42' }, d);

    // No completion to re-drive off a get → payload stays null.
    expect(d.formPending.get('sub_1')?.paymentPayload).toBeNull();
  });

  it('with NO handoff deps (FORMBRIDGE_URL unset), returns the RAW escalation unchanged', async () => {
    const res = await gateCompleteCheckout(
      makeBuyerInputMerchant(),
      approvingGate,
      { meta: AGENT_META, id: 'co_42', checkout: PAYMENT },
      {},
      undefined,
      undefined,
      undefined
    );
    const sc = res.structuredContent as Checkout;
    expect(sc.status).toBe('requires_escalation');
    // The merchant's raw buyer-input message survives untouched; no resume URL.
    expect(sc.messages?.[0]?.code).toBe('buyer_input_required');
    expect(sc.continue_url).toBeUndefined();
  });

  it("(a′) buyer-input-at-GET + FORMBRIDGE unset ⇒ NO short-circuit: gate evidence emitted + gate evaluated", async () => {
    // The authoritative GET is ALREADY a buyer-input escalation.
    const buyerInputAtGet: Checkout = {
      id: 'co_42',
      status: 'requires_escalation',
      currency: 'USD',
      messages: [
        {
          type: 'error',
          code: 'buyer_input_required',
          severity: 'requires_buyer_input',
          path: '$.buyer.phone_number',
          content: 'A contact phone number is required.',
        },
      ],
    };
    const mCalls: string[] = [];
    const merchant = {
      base: 'https://merchant.example',
      getCheckout: () => {
        mCalls.push('getCheckout');
        return Promise.resolve(buyerInputAtGet);
      },
      completeCheckout: () => {
        mCalls.push('completeCheckout');
        return Promise.resolve(buyerInputAtGet); // merchant surfaces the escalation naturally
      },
    } as unknown as MerchantClient;

    const gCalls: unknown[] = [];
    const spyGate: Gate = {
      evaluate: (facts) => {
        gCalls.push(facts);
        return Promise.resolve({ status: 'approved' as const });
      },
      continueUrl: (id: string) => `https://gate.example/requests/${id}`,
    };

    const events: string[] = [];
    const recorder: EvidenceRecorder = {
      logEvents: (batch) => {
        for (const e of batch) events.push(e.payload.type);
        return Promise.resolve();
      },
    };

    await gateCompleteCheckout(
      merchant,
      spyGate,
      { meta: AGENT_META, id: 'co_42', checkout: PAYMENT },
      {},
      undefined,
      recorder,
      undefined // FORMBRIDGE unset ⇒ no handoff
    );

    // The (a′) short-circuit did NOT fire: the spend gate ran and the completion
    // was attempted (the merchant surfaces the escalation naturally).
    expect(gCalls).toHaveLength(1);
    expect(mCalls).toContain('completeCheckout');
    expect(events).toContain('ucp.complete_checkout.received');
    expect(events).toContain('ucp.gate.decision');
  });
});
