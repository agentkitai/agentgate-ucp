/**
 * Best-effort AgentLens evidence recorder.
 *
 * Every gated purchase self-emits a tamper-evident, hash-chained timeline into
 * AgentLens via `POST {url}/api/events`. AgentLens hash-chains events per
 * `sessionId` SERVER-SIDE (the client does NOT supply prevHash), so we key one
 * AgentLens session per checkout — `sessionId = "ucp_" + checkoutId` — and every
 * lifecycle event of that purchase chains onto the same verifiable session.
 *
 * FAIL-OPEN by contract: a checkout must NEVER fail because AgentLens is down,
 * misconfigured, or unset. Every method here swallows errors (logged at debug via
 * `AGENTLENS_DEBUG`) and returns; nothing throws or blocks the tool call. When
 * `url` is unset the recorder is a no-op.
 *
 * AgentLens's `custom` event payload schema is `{ type, data }` (data is a record),
 * so {@link recordGateEvent} nests the caller's flat `data` under `payload.data`.
 */

/** One event in the shape AgentLens's `POST /api/events` batch expects. */
export interface AgentLensEventInput {
  sessionId: string;
  agentId: string;
  /** 'custom' for our lifecycle events (unconstrained payload). */
  eventType: string;
  /** 'info' for every lifecycle event. */
  severity: string;
  /** AgentLens `custom` payload: a discriminating `type` + a `data` record. */
  payload: { type: string; data: Record<string, unknown> };
  metadata: Record<string, unknown>;
  /** Optional client timestamp; the server defaults to now and chains in order. */
  timestamp?: string | undefined;
}

/**
 * The seam the emit sites depend on. {@link AgentLensRecorder} is the real
 * HTTP-backed implementation; tests inject a stub with the same single method.
 */
export interface EvidenceRecorder {
  logEvents(events: AgentLensEventInput[]): Promise<void>;
}

/** The flat, wire-agnostic input an emit site hands to {@link recordGateEvent}. */
export interface GateEventInput {
  sessionId: string;
  agentId: string;
  /** The lifecycle discriminator, e.g. 'ucp.order.placed'. */
  type: string;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface AgentLensRecorderOptions {
  /** AgentLens base URL (AGENTLENS_URL). Unset → the recorder is a no-op. */
  url?: string | undefined;
  /** Bearer API key (AGENTLENS_API_KEY). Omitted when the server runs AUTH_DISABLED. */
  apiKey?: string | undefined;
  /** AgentGate agent token (AGENTLENS_AGENT_TOKEN) for verified-agent evidence (Tier B). */
  agentToken?: string | undefined;
  /** Injectable fetch (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
}

function debug(msg: string): void {
  // Fail-open is deliberately quiet; opt in to failure logs with AGENTLENS_DEBUG.
  if (process.env['AGENTLENS_DEBUG']) {
    console.debug(`[agentgate-ucp:agentlens] ${msg}`);
  }
}

export class AgentLensRecorder implements EvidenceRecorder {
  private readonly url: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly agentToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentLensRecorderOptions = {}) {
    this.url = opts.url ? opts.url.replace(/\/+$/, '') : undefined;
    this.apiKey = opts.apiKey;
    this.agentToken = opts.agentToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** True when an AgentLens URL is configured (otherwise every call is a no-op). */
  get enabled(): boolean {
    return this.url !== undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    // Only sent when set — required for Tier B signed (verified-agent) packs.
    if (this.agentToken) headers['X-Agent-Token'] = this.agentToken;
    return headers;
  }

  /**
   * POST a batch of events to AgentLens. NEVER throws and NEVER rejects: awaiting
   * this resolves even on a network error, a non-2xx, or an unset URL — so an emit
   * site can `void recorder.logEvents(...)` on the hot path with no risk of
   * breaking a checkout.
   */
  async logEvents(events: AgentLensEventInput[]): Promise<void> {
    if (!this.url || events.length === 0) return;
    try {
      const res = await this.fetchImpl(`${this.url}/api/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ events }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        debug(`ingest returned ${res.status}: ${detail.slice(0, 300)}`);
      }
    } catch (err) {
      debug(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * POST a signed evidence pack request (Tier B). Best-effort: returns the parsed
   * JSON body, or `undefined` if unconfigured / on any failure.
   */
  async exportEvidence(
    agentId: string,
    from: string,
    to: string,
    types: string[] = ['custom']
  ): Promise<unknown | undefined> {
    if (!this.url) return undefined;
    try {
      const res = await this.fetchImpl(`${this.url}/api/audit/evidence/export`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ agentId, from, to, types }),
      });
      if (!res.ok) {
        debug(`evidence export returned ${res.status}`);
        return undefined;
      }
      return (await res.json()) as unknown;
    } catch (err) {
      debug(`evidence export failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}

/**
 * Build ONE lifecycle event from a flat {@link GateEventInput} and fire it at the
 * recorder. Fire-and-forget: this returns `void`, never awaits, and can NEVER
 * throw — even if the recorder's `logEvents` rejects OR throws synchronously (a
 * misbehaving/stub recorder), the error is swallowed. `recorder` may be absent
 * (AgentLens unconfigured) → no-op. This is THE fail-open seam on the hot path.
 */
export function recordGateEvent(
  recorder: EvidenceRecorder | undefined,
  input: GateEventInput
): void {
  if (!recorder) return;
  const event: AgentLensEventInput = {
    sessionId: input.sessionId,
    agentId: input.agentId,
    eventType: 'custom',
    severity: 'info',
    payload: { type: input.type, data: input.data },
    metadata: input.metadata,
  };
  try {
    // Promise.resolve guards a recorder whose logEvents returns a non-promise;
    // .catch guards async rejection; the try/catch guards a synchronous throw.
    void Promise.resolve(recorder.logEvents([event])).catch(() => {});
  } catch {
    // A recorder must never break a checkout.
  }
}
