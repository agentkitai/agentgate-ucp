/**
 * SQLite-backed parked-session store. A parked row lets the decision webhook —
 * a different connection than the original MCP call — resume a completion with
 * zero in-memory state; the `status` guard makes duplicate (at-least-once)
 * webhook deliveries safe.
 */
import Database from 'better-sqlite3';

export type ParkedStatus = 'pending' | 'approved_replayed' | 'denied' | 'error';

export interface ParkedSession {
  /** AgentGate request.id — the webhook correlation key (PK). */
  approvalId: string;
  checkoutId: string;
  /** The UCP complete idempotency-key — replay-critical. */
  idempotencyKey: string;
  /**
   * The buying agent id (from `meta['ucp-agent']`). Optional: carried so the
   * webhook-resume AgentLens evidence events are attributed to the SAME agent as
   * the original completion, keeping one coherent per-checkout session chain.
   */
  agentId?: string | undefined;
  mcpSessionId: string | undefined;
  checkoutSnapshot: unknown;
  merchantBaseUrl: string;
  status: ParkedStatus;
  orderResult: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ParkedSessionStore {
  put(session: ParkedSession): void;
  get(approvalId: string): ParkedSession | undefined;
  markStatus(approvalId: string, status: ParkedStatus, orderResult?: unknown): void;
}

/** Row shape as stored on disk (snake_case columns; JSON blobs as TEXT). */
interface ParkedRow {
  approval_id: string;
  checkout_id: string;
  idempotency_key: string;
  agent_id: string | null;
  mcp_session_id: string | null;
  checkout_snapshot: string;
  merchant_base_url: string;
  status: string;
  order_result: string | null;
  created_at: string;
  updated_at: string;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS parked_sessions (
    approval_id       TEXT PRIMARY KEY,
    checkout_id       TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL,
    agent_id          TEXT,
    mcp_session_id    TEXT,
    checkout_snapshot TEXT NOT NULL,
    merchant_base_url TEXT NOT NULL,
    status            TEXT NOT NULL,
    order_result      TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )
`;

/**
 * Open (or create) the parked-session store backed by better-sqlite3.
 * Pass `':memory:'` for an ephemeral store (tests).
 */
export function openParkedStore(sqlitePath: string): ParkedSessionStore {
  const db = new Database(sqlitePath);
  // WAL improves concurrency between the MCP request path (which parks rows) and
  // the webhook path (which resumes them). No-op for an in-memory DB.
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE);

  const putStmt = db.prepare(
    `INSERT OR REPLACE INTO parked_sessions
       (approval_id, checkout_id, idempotency_key, agent_id, mcp_session_id, checkout_snapshot,
        merchant_base_url, status, order_result, created_at, updated_at)
     VALUES
       (@approval_id, @checkout_id, @idempotency_key, @agent_id, @mcp_session_id, @checkout_snapshot,
        @merchant_base_url, @status, @order_result, @created_at, @updated_at)`
  );
  const getStmt = db.prepare(`SELECT * FROM parked_sessions WHERE approval_id = ?`);
  const markStmt = db.prepare(
    `UPDATE parked_sessions SET status = @status, order_result = @order_result, updated_at = @updated_at
     WHERE approval_id = @approval_id`
  );

  return {
    put(session: ParkedSession): void {
      putStmt.run({
        approval_id: session.approvalId,
        checkout_id: session.checkoutId,
        idempotency_key: session.idempotencyKey,
        agent_id: session.agentId ?? null,
        mcp_session_id: session.mcpSessionId ?? null,
        // `undefined` payloads serialise to the literal "null" so the column stays NOT NULL.
        checkout_snapshot: JSON.stringify(session.checkoutSnapshot ?? null),
        merchant_base_url: session.merchantBaseUrl,
        status: session.status,
        order_result:
          session.orderResult === undefined || session.orderResult === null
            ? null
            : JSON.stringify(session.orderResult),
        created_at: session.createdAt,
        updated_at: session.updatedAt,
      });
    },

    get(approvalId: string): ParkedSession | undefined {
      const row = getStmt.get(approvalId) as ParkedRow | undefined;
      if (!row) return undefined;
      return {
        approvalId: row.approval_id,
        checkoutId: row.checkout_id,
        idempotencyKey: row.idempotency_key,
        agentId: row.agent_id ?? undefined,
        mcpSessionId: row.mcp_session_id ?? undefined,
        checkoutSnapshot: JSON.parse(row.checkout_snapshot),
        merchantBaseUrl: row.merchant_base_url,
        status: row.status as ParkedStatus,
        orderResult: row.order_result === null ? null : JSON.parse(row.order_result),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    markStatus(approvalId: string, status: ParkedStatus, orderResult?: unknown): void {
      markStmt.run({
        approval_id: approvalId,
        status,
        order_result:
          orderResult === undefined || orderResult === null
            ? null
            : JSON.stringify(orderResult),
        updated_at: new Date().toISOString(),
      });
    },
  };
}
