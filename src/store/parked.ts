/**
 * SQLite-backed parked-session store. A parked row lets the decision webhook —
 * a different connection than the original MCP call — resume a completion with
 * zero in-memory state; the `status` guard makes duplicate (at-least-once)
 * webhook deliveries safe.
 *
 * TODO(#10): implement with better-sqlite3.
 */
export type ParkedStatus = 'pending' | 'approved_replayed' | 'denied' | 'error';

export interface ParkedSession {
  /** AgentGate request.id — the webhook correlation key (PK). */
  approvalId: string;
  checkoutId: string;
  /** The UCP complete idempotency-key — replay-critical. */
  idempotencyKey: string;
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

export function openParkedStore(_sqlitePath: string): ParkedSessionStore {
  throw new Error('openParkedStore not implemented (task #10)');
}
