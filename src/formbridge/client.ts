/**
 * Thin HTTP client for FormBridge — the typed form-handoff service.
 *
 * Two operations back gate point 3:
 *   - {@link FormBridgeClient.registerIntake} — POST /intakes (create-only). On a
 *     409 (id already exists) it upserts via PUT /intakes/:id, so re-issuing the
 *     per-checkout intake is idempotent.
 *   - {@link FormBridgeClient.createSubmission} — POST /intake/:id/submissions with
 *     the actor + prefilled `initialFields`, returning `{submissionId, resumeToken}`.
 *
 * Auth: a Bearer `FORMBRIDGE_API_KEY` is sent when configured; the local dev
 * FormBridge typically runs with auth disabled (no key needed). Every non-2xx is
 * raised as a typed {@link FormBridgeError} carrying the status + body.
 */
import type { JSONSchema } from '../schema/json-schema';

/** The subset of an actor FormBridge records on a submission. */
export interface FormBridgeActor {
  kind: 'agent' | 'human' | 'system';
  id: string;
  name?: string | undefined;
}

/** An intake destination (where FormBridge POSTs the completed submission). */
export interface FormBridgeDestination {
  kind: 'webhook';
  url: string;
  headers?: Record<string, string> | undefined;
}

/** An intake definition as accepted on the HTTP `/intakes` path (JSON-Schema `schema`). */
export interface FormBridgeIntakeDefinition {
  id: string;
  version: string;
  name: string;
  description?: string | undefined;
  schema: JSONSchema;
  destination: FormBridgeDestination;
  ttlMs?: number | undefined;
}

/** Result of creating a submission. */
export interface CreatedSubmission {
  submissionId: string;
  resumeToken: string;
  state?: string | undefined;
}

/** Raised on any FormBridge non-2xx or transport failure. */
export class FormBridgeError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, operation: string) {
    super(`FormBridge ${operation} failed (${status}): ${FormBridgeError.detail(body)}`);
    this.name = 'FormBridgeError';
    this.status = status;
    this.body = body;
  }
  private static detail(body: unknown): string {
    if (body && typeof body === 'object') {
      const err = (body as { error?: unknown }).error;
      if (err && typeof err === 'object' && 'message' in err) {
        return String((err as { message: unknown }).message);
      }
      return JSON.stringify(body);
    }
    return typeof body === 'string' ? body : JSON.stringify(body);
  }
}

export interface FormBridgeClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  /** Injectable fetch (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
}

export class FormBridgeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FormBridgeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async send(
    operation: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    if (!res.ok) throw new FormBridgeError(res.status, parsed, operation);
    return parsed;
  }

  /**
   * Register (or upsert) a per-checkout intake. POST is create-only; a 409 means
   * the intake already exists, so we PUT to replace it in place (idempotent).
   */
  async registerIntake(def: FormBridgeIntakeDefinition): Promise<void> {
    try {
      await this.send('registerIntake', 'POST', '/intakes', def);
    } catch (err) {
      if (err instanceof FormBridgeError && err.status === 409) {
        await this.send('upsertIntake', 'PUT', `/intakes/${encodeURIComponent(def.id)}`, def);
        return;
      }
      throw err;
    }
  }

  /**
   * Create a submission for `intakeId`, prefilling any agent-known fields. When an
   * `idempotencyKey` is supplied FormBridge dedups on it, so repeated handoffs for
   * the same checkout (e.g. `get_checkout` polling) mint ONE submission.
   */
  async createSubmission(
    intakeId: string,
    opts: { actor: FormBridgeActor; initialFields?: Record<string, unknown>; idempotencyKey?: string }
  ): Promise<CreatedSubmission> {
    const body: Record<string, unknown> = { actor: opts.actor };
    if (opts.initialFields && Object.keys(opts.initialFields).length > 0) {
      body['initialFields'] = opts.initialFields;
    }
    if (opts.idempotencyKey) body['idempotencyKey'] = opts.idempotencyKey;
    const res = await this.send(
      'createSubmission',
      'POST',
      `/intake/${encodeURIComponent(intakeId)}/submissions`,
      body
    );
    const r = (res ?? {}) as { submissionId?: unknown; resumeToken?: unknown; state?: unknown };
    if (typeof r.submissionId !== 'string' || typeof r.resumeToken !== 'string') {
      throw new FormBridgeError(200, res, 'createSubmission (missing submissionId/resumeToken)');
    }
    return {
      submissionId: r.submissionId,
      resumeToken: r.resumeToken,
      state: typeof r.state === 'string' ? r.state : undefined,
    };
  }
}
