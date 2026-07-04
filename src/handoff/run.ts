/**
 * The ONE shared detect+handoff seam used by both `complete_checkout` (after the
 * authoritative GET and after the approved completion) and the create/update/get
 * passthrough. Given a merchant Checkout and the correlation needed to later
 * re-drive it, it:
 *
 *   1. detects `requires_buyer_input` messages (no-op for any other result);
 *   2. builds + registers a TYPED per-checkout FormBridge intake and a prefilled
 *      submission (via {@link buildBuyerInputIntake});
 *   3. PARKS a form-pending row keyed by the submission id;
 *   4. emits `ucp.buyer_input.requested` evidence;
 *   5. returns a UCP `requires_escalation` Checkout whose `continue_url` is the
 *      human's FormBridge resume URL.
 *
 * FAIL-SAFE by contract: with no {@link HandoffDeps} (FORMBRIDGE_URL unset) the
 * original checkout is returned unchanged (the raw escalation); a FormBridge or
 * schema error is logged and ALSO degrades to the raw escalation — a buyer-input
 * result must NEVER crash the tool call.
 */
import type { EvidenceRecorder } from '../observability/agentlens';
import { recordGateEvent } from '../observability/agentlens';
import type { FormBridgeClient } from '../formbridge/client';
import type { FormPendingStore } from '../store/form-pending';
import type { Checkout } from '../types';
import { buildBuyerInputIntake, resumeUrlForToken } from './build-intake';
import type { BuyerInputMessage } from './detect';
import { detectBuyerInput } from './detect';

const EVIDENCE_SOURCE = 'agentgate-ucp';

/** The optional service bundle that ENABLES form handoff. Absent ⇒ raw escalation. */
export interface HandoffDeps {
  fbClient: FormBridgeClient;
  formPending: FormPendingStore;
  /** Public FormBridge URL the human's resume link points at. */
  formbridgePublicUrl: string;
  /** Adapter webhook URL FormBridge POSTs the completed submission back to. */
  adapterWebhookUrl: string;
  recorder?: EvidenceRecorder | undefined;
}

/**
 * ponytail: a plain per-checkout row cap instead of a stateful round counter. Each
 * genuinely-new form (a fresh buyer-input round) parks one row; a runaway merchant
 * that keeps demanding a new field on every re-drive is bounded here rather than
 * spawning forms forever. 10 is far above any real staged checkout; hitting it
 * degrades to the raw escalation (the answer-back then leaves the row recoverable).
 */
const MAX_HANDOFF_ROUNDS = 10;

/** Options controlling a single handoff attempt. */
export interface HandoffOptions {
  /**
   * Skip the idempotent per-checkout reuse and always park a NEW form/row. Set ONLY
   * by the answer-back re-drive: a renewed buyer-input on the re-drive is a genuinely
   * NEW field request (round 2+), so it must mint its own form rather than reuse the
   * just-answered round-1 row (which is mid-`processing`).
   */
  forceFresh?: boolean | undefined;
}

/** Everything the answer-back path needs to later resolve THIS checkout. */
export interface HandoffContext {
  checkoutId: string;
  merchantBaseUrl: string;
  agentId: string;
  ucpAgent?: string | undefined;
  /** ORIGINAL `complete_checkout` payment payload; `null` for passthrough handoffs. */
  paymentPayload: unknown;
  /** Pinned idempotency-key of the original completion (or a fresh one). */
  idempotencyKey: string;
}

/** A parked payload is "empty" (no completion to re-drive) when it is null/undefined. */
function isEmptyPayload(payload: unknown): boolean {
  return payload === null || payload === undefined;
}

/**
 * A UCP `requires_escalation` Checkout that points the human at the FormBridge
 * resume URL, preserving the merchant's buyer-input messages.
 */
export function buyerInputCheckout(
  checkoutId: string,
  resumeUrl: string,
  messages: BuyerInputMessage[]
): Checkout {
  return {
    id: checkoutId,
    status: 'requires_escalation',
    continue_url: resumeUrl,
    messages: messages.map((m) => ({
      type: 'info',
      code: m.code ?? 'buyer_input_required',
      severity: 'requires_buyer_input',
      content: m.content ?? 'Additional information is required to complete your purchase.',
      path: m.path,
    })),
  };
}

/**
 * Detect a buyer-input escalation and, when handoff is enabled, run it. Returns
 * the checkout to hand back to the agent: the original when there is no
 * buyer-input (or handoff is disabled/failed), or a form-backed escalation.
 * NEVER throws.
 */
export async function maybeHandoffBuyerInput(
  checkout: Checkout,
  ctx: HandoffContext,
  deps: HandoffDeps | undefined,
  opts: HandoffOptions = {}
): Promise<Checkout> {
  const messages = detectBuyerInput(checkout);
  if (messages.length === 0) return checkout; // not a buyer-input escalation → unchanged
  if (!deps) return checkout; // FormBridge unconfigured → raw escalation (fail-safe)

  const sessionId = `ucp_${ctx.checkoutId}`;
  try {
    // STATUS-AWARE idempotent handoff. A repeat detect for THIS checkout (e.g. a
    // `get_checkout` poll, or a completion after an earlier get) must not corrupt the
    // form's state machine. Keyed on the most-recent row's status:
    //   pending    — the form is live and unanswered → reuse its resume URL. If it was
    //                parked off a passthrough get/update (no payload) and THIS call is
    //                the completion, upgrade it with the real payload + pinned key so
    //                answer-back can re-drive the order.
    //   processing — an answer-back is mid-flight → reuse the in-flight URL, but NEVER
    //                put/rebuild (that would reset the in-progress row back to pending).
    //   resolved/  — terminal: the form's lifecycle is over. Do NOT resurrect it and do
    //   denied       NOT spawn a new one → treat as no-handoff (raw escalation).
    //   error      — a prior handoff failed transiently → allow a fresh handoff.
    // `forceFresh` (answer-back re-drive) skips reuse entirely to mint a NEW round.
    if (!opts.forceFresh) {
      const existing = deps.formPending.getByCheckoutId(ctx.checkoutId);
      if (existing) {
        const reuse = (): Checkout => {
          const resumeUrl = resumeUrlForToken(deps.formbridgePublicUrl, existing.resumeToken!);
          return buyerInputCheckout(ctx.checkoutId, resumeUrl, messages);
        };
        switch (existing.status) {
          case 'pending':
            if (existing.resumeToken) {
              if (isEmptyPayload(existing.paymentPayload) && !isEmptyPayload(ctx.paymentPayload)) {
                deps.formPending.upgradePayload(
                  existing.submissionId,
                  ctx.paymentPayload,
                  ctx.idempotencyKey
                );
              }
              return reuse();
            }
            break; // no resume token (shouldn't happen) → fall through to a fresh build
          case 'processing':
            if (existing.resumeToken) return reuse();
            break;
          case 'resolved':
          case 'denied':
            return checkout; // terminal → raw escalation, no resurrection, no new row
          case 'error':
            break; // allow a fresh handoff below
        }
      }
    }

    // Bound runaway re-handoff (a merchant that demands a new field every re-drive).
    if (deps.formPending.countByCheckoutId(ctx.checkoutId) >= MAX_HANDOFF_ROUNDS) {
      console.warn(
        `[agentgate-ucp] checkout ${ctx.checkoutId} exceeded ${MAX_HANDOFF_ROUNDS} buyer-input rounds; returning raw escalation`
      );
      return checkout;
    }

    const result = await buildBuyerInputIntake({
      checkout,
      messages,
      fbClient: deps.fbClient,
      formbridgePublicUrl: deps.formbridgePublicUrl,
      adapterWebhookUrl: deps.adapterWebhookUrl,
      agentId: ctx.agentId,
    });

    const now = new Date().toISOString();
    deps.formPending.put({
      submissionId: result.submissionId,
      checkoutId: ctx.checkoutId,
      intakeId: result.intakeId,
      merchantBaseUrl: ctx.merchantBaseUrl,
      paymentPayload: ctx.paymentPayload ?? null,
      idempotencyKey: ctx.idempotencyKey,
      fieldMap: result.fieldMap,
      resumeToken: result.resumeToken,
      agentId: ctx.agentId,
      ucpAgent: ctx.ucpAgent,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    recordGateEvent(deps.recorder, {
      sessionId,
      agentId: ctx.agentId,
      type: 'ucp.buyer_input.requested',
      data: {
        submissionId: result.submissionId,
        intakeId: result.intakeId,
        resumeUrl: result.resumeUrl,
        fields: result.fieldKeys,
        paths: Object.values(result.fieldMap),
      },
      metadata: {
        checkoutId: ctx.checkoutId,
        idempotencyKey: ctx.idempotencyKey,
        source: EVIDENCE_SOURCE,
      },
    });

    return buyerInputCheckout(ctx.checkoutId, result.resumeUrl, messages);
  } catch (err) {
    // Never crash the tool call: degrade to the raw escalation.
    console.error(
      `[agentgate-ucp] buyer-input handoff failed for checkout ${ctx.checkoutId}; returning raw escalation: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return checkout;
  }
}
