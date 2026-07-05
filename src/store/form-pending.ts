/**
 * SQLite-backed form-pending store (gate point 3).
 *
 * When a `requires_buyer_input` escalation is handed off to a FormBridge form, we
 * park a row keyed by the FormBridge `submissionId` so the answer-back webhook —
 * a different connection than the original tool call — can, with zero in-memory
 * state, resolve the checkout: re-send the human's answers to the merchant and
 * re-drive completion with the ORIGINAL payment payload + pinned idempotency-key.
 * The `status` guard makes duplicate (at-least-once) webhook deliveries safe.
 */
import Database from 'better-sqlite3';

/**
 * Lifecycle of a parked buyer-input form:
 *   pending    — awaiting the human's answer-back webhook (re-claimable).
 *   processing — claimed by an in-flight handler (NOT re-claimable: guards the
 *                single-processor invariant against a duplicate delivery).
 *   error      — a transient failure re-driving the completion; re-claimable so a
 *                webhook retry re-drives the order (never silently dropped).
 *   resolved   — the buyer input was applied + the completion re-driven (or parked
 *                for spend approval). Terminal.
 *   denied     — the re-driven completion was denied by spend policy (no order).
 *                Terminal.
 *   failed     — a PERMANENT merchant 4xx on the re-drive (canceled/invalid). Terminal:
 *                never re-executed, even if a redelivery slips through a lost ack.
 * Only `pending`/`error` are re-claimable; `processing`/`resolved`/`denied`/`failed` are not.
 */
export type FormPendingStatus =
  | 'pending'
  | 'processing'
  | 'resolved'
  | 'denied'
  | 'error'
  | 'failed';

/**
 * ponytail: a plain time lease instead of a heartbeat/renewal protocol. A hard
 * crash (SIGKILL/OOM/reboot) between {@link FormPendingStore.claim} and the
 * terminal {@link FormPendingStore.markStatus} would otherwise strand a row in
 * `processing` FOREVER — every FormBridge redelivery then gets `ignored`→200 and
 * the answered order is silently lost. So a `processing` row older than LEASE_MS
 * is reclaimable: the next delivery re-drives it (the pinned idempotency-key makes
 * a duplicate re-drive safe). 60s comfortably exceeds one answer-back re-drive
 * (GET+update+complete); the only cost of it being "too short" is a safe duplicate.
 */
const LEASE_MS = 60_000;

/** Maps each form field key back to the checkout JSONPath its answer writes to. */
export type FieldMap = Record<string, string>;

export interface FormPendingSession {
  /** FormBridge submission id — the answer-back correlation key (PK). */
  submissionId: string;
  checkoutId: string;
  /** The FormBridge intake this submission belongs to. */
  intakeId: string;
  merchantBaseUrl: string;
  /**
   * The ORIGINAL `complete_checkout` payment payload to replay after the human's
   * answers are merged. `null` when the handoff came off a passthrough
   * create/update/get (no completion to re-drive — answer-back only updates).
   */
  paymentPayload: unknown;
  /** Pinned idempotency-key of the original completion (replay-critical). */
  idempotencyKey: string;
  /** fieldKey → JSONPath, so an answer for `buyer__phone_number` writes to `$.buyer.phone_number`. */
  fieldMap: FieldMap;
  /**
   * FormBridge resume token, so a repeat handoff for the SAME still-pending
   * checkout can rebuild the human's resume URL and reuse this submission rather
   * than minting a new one (idempotent handoff).
   */
  resumeToken?: string | undefined;
  /** Buying-agent id (for coherent per-checkout AgentLens attribution). */
  agentId?: string | undefined;
  /** The raw `UCP-Agent` header string, replayed on the merchant update/complete. */
  ucpAgent?: string | undefined;
  status: FormPendingStatus;
  /**
   * When the row was last moved to `processing` by {@link FormPendingStore.claim}
   * (the lease clock). A `processing` row whose lease has expired is reclaimable so
   * a crash mid-processing can never strand the answered order. `undefined` until
   * first claimed.
   */
  claimedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface FormPendingStore {
  put(session: FormPendingSession): void;
  get(submissionId: string): FormPendingSession | undefined;
  /** The most recent row for a checkout (any status). Used for idempotent handoff. */
  getByCheckoutId(checkoutId: string): FormPendingSession | undefined;
  markStatus(submissionId: string, status: FormPendingStatus): void;
  /**
   * Atomically transition a re-claimable row to `processing`, returning whether
   * THIS call won the row. The single UPDATE is the concurrency primitive: of N
   * simultaneous deliveries for one submission, exactly one sees a changed row.
   *
   * Re-claimable ⇔ `pending`/`error` OR a `processing` row whose lease has expired
   * (`claimed_at < now - LEASE_MS`) — a crash-stranded row. A FRESH `processing`
   * row (within its lease) is NOT claimable, preserving the single-processor
   * guarantee against a duplicate delivery. Terminal (`resolved`/`denied`) rows are
   * never claimable.
   */
  claim(submissionId: string): boolean;
  /**
   * Fill in the payment payload + pinned idempotency-key of an EXISTING row without
   * touching its status/resumeToken. Used when a handoff first parked off a
   * passthrough `get`/`update` (no payload) and a later `complete_checkout` reuses
   * that row: the completion carries the real payload the answer-back must re-drive.
   */
  upgradePayload(submissionId: string, paymentPayload: unknown, idempotencyKey: string): void;
  /** How many rows exist for a checkout (any status) — bounds runaway re-handoff rounds. */
  countByCheckoutId(checkoutId: string): number;
}

interface FormPendingRow {
  submission_id: string;
  checkout_id: string;
  intake_id: string;
  merchant_base_url: string;
  payment_payload: string;
  idempotency_key: string;
  field_map: string;
  resume_token: string | null;
  agent_id: string | null;
  ucp_agent: string | null;
  status: string;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS form_pending (
    submission_id     TEXT PRIMARY KEY,
    checkout_id       TEXT NOT NULL,
    intake_id         TEXT NOT NULL,
    merchant_base_url TEXT NOT NULL,
    payment_payload   TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL,
    field_map         TEXT NOT NULL,
    resume_token      TEXT,
    agent_id          TEXT,
    ucp_agent         TEXT,
    status            TEXT NOT NULL,
    claimed_at        TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )
`;

/** Index the answer-back correlation column so `getByCheckoutId` is a keyed lookup. */
const CREATE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_form_pending_checkout ON form_pending (checkout_id)
`;

/** Open (or create) the form-pending store. Pass `':memory:'` for tests. */
export function openFormPendingStore(sqlitePath: string): FormPendingStore {
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE);
  db.exec(CREATE_INDEX);
  // Migrate a pre-lease DB (gate-3 was uncommitted, but a dev .db from before the
  // lease must not crash the reaper): add claimed_at if it is missing.
  try {
    db.exec(`ALTER TABLE form_pending ADD COLUMN claimed_at TEXT`);
  } catch {
    /* column already exists — nothing to migrate */
  }

  const putStmt = db.prepare(
    `INSERT OR REPLACE INTO form_pending
       (submission_id, checkout_id, intake_id, merchant_base_url, payment_payload, idempotency_key,
        field_map, resume_token, agent_id, ucp_agent, status, claimed_at, created_at, updated_at)
     VALUES
       (@submission_id, @checkout_id, @intake_id, @merchant_base_url, @payment_payload, @idempotency_key,
        @field_map, @resume_token, @agent_id, @ucp_agent, @status, @claimed_at, @created_at, @updated_at)`
  );
  const getStmt = db.prepare(`SELECT * FROM form_pending WHERE submission_id = ?`);
  const getByCheckoutStmt = db.prepare(
    `SELECT * FROM form_pending WHERE checkout_id = ? ORDER BY created_at DESC LIMIT 1`
  );
  const countByCheckoutStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM form_pending WHERE checkout_id = ?`
  );
  const markStmt = db.prepare(
    `UPDATE form_pending SET status = @status, updated_at = @updated_at WHERE submission_id = @submission_id`
  );
  const upgradeStmt = db.prepare(
    `UPDATE form_pending SET payment_payload = @payment_payload, idempotency_key = @idempotency_key,
       updated_at = @updated_at WHERE submission_id = @submission_id`
  );
  // Atomic claim + reclaim: a pending/error row, OR a processing row whose lease has
  // expired (crash-stranded), is moved to processing and its lease renewed. A fresh
  // processing row (claimed_at >= @stale_before) is NOT matched — single-processor.
  const claimStmt = db.prepare(
    `UPDATE form_pending SET status = 'processing', claimed_at = @claimed_at, updated_at = @updated_at
       WHERE submission_id = @submission_id
         AND (status IN ('pending', 'error')
              OR (status = 'processing' AND claimed_at < @stale_before))`
  );

  const toSession = (row: FormPendingRow): FormPendingSession => ({
    submissionId: row.submission_id,
    checkoutId: row.checkout_id,
    intakeId: row.intake_id,
    merchantBaseUrl: row.merchant_base_url,
    paymentPayload: JSON.parse(row.payment_payload),
    idempotencyKey: row.idempotency_key,
    fieldMap: JSON.parse(row.field_map) as FieldMap,
    resumeToken: row.resume_token ?? undefined,
    agentId: row.agent_id ?? undefined,
    ucpAgent: row.ucp_agent ?? undefined,
    status: row.status as FormPendingStatus,
    claimedAt: row.claimed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    put(session: FormPendingSession): void {
      putStmt.run({
        submission_id: session.submissionId,
        checkout_id: session.checkoutId,
        intake_id: session.intakeId,
        merchant_base_url: session.merchantBaseUrl,
        // `undefined` payloads serialise to the literal "null" so the column stays NOT NULL.
        payment_payload: JSON.stringify(session.paymentPayload ?? null),
        idempotency_key: session.idempotencyKey,
        field_map: JSON.stringify(session.fieldMap),
        resume_token: session.resumeToken ?? null,
        agent_id: session.agentId ?? null,
        ucp_agent: session.ucpAgent ?? null,
        status: session.status,
        claimed_at: session.claimedAt ?? null,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
      });
    },

    get(submissionId: string): FormPendingSession | undefined {
      const row = getStmt.get(submissionId) as FormPendingRow | undefined;
      return row ? toSession(row) : undefined;
    },

    getByCheckoutId(checkoutId: string): FormPendingSession | undefined {
      const row = getByCheckoutStmt.get(checkoutId) as FormPendingRow | undefined;
      return row ? toSession(row) : undefined;
    },

    markStatus(submissionId: string, status: FormPendingStatus): void {
      markStmt.run({ submission_id: submissionId, status, updated_at: new Date().toISOString() });
    },

    claim(submissionId: string): boolean {
      const now = Date.now();
      const info = claimStmt.run({
        submission_id: submissionId,
        claimed_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        // ISO-8601 UTC strings sort lexicographically, so a plain `<` compares the
        // stored claim time against the lease horizon without any date parsing.
        stale_before: new Date(now - LEASE_MS).toISOString(),
      });
      return info.changes > 0;
    },

    upgradePayload(submissionId: string, paymentPayload: unknown, idempotencyKey: string): void {
      upgradeStmt.run({
        submission_id: submissionId,
        payment_payload: JSON.stringify(paymentPayload ?? null),
        idempotency_key: idempotencyKey,
        updated_at: new Date().toISOString(),
      });
    },

    countByCheckoutId(checkoutId: string): number {
      const row = countByCheckoutStmt.get(checkoutId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
  };
}
