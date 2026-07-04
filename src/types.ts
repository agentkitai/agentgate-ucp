/**
 * Minimal UCP shapes the gate reads. The merchant is authoritative for totals;
 * we deliberately model only what the gate needs, not the whole spec.
 */

export type CheckoutStatus =
  | 'incomplete'
  | 'requires_escalation'
  | 'ready_for_complete'
  | 'complete_in_progress'
  | 'completed'
  | 'canceled';

export type MessageSeverity =
  | 'recoverable'
  | 'requires_buyer_input'
  | 'requires_buyer_review'
  | 'unrecoverable';

export interface CheckoutTotal {
  /** e.g. "items", "shipping", "tax", "total" */
  type: string;
  /** Minor units (cents). */
  amount: number;
}

export interface CheckoutMessage {
  type: string;
  code?: string;
  severity?: MessageSeverity;
  content?: string;
  /** RFC 9535 JSONPath to the component the message refers to. */
  path?: string;
}

export interface Checkout {
  id: string;
  status: CheckoutStatus;
  currency?: string;
  totals?: CheckoutTotal[];
  line_items?: Array<Record<string, unknown>>;
  messages?: CheckoutMessage[];
  /** HTTPS URL a buyer follows to resolve an escalation. */
  continue_url?: string;
  order?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The five UCP checkout MCP tools the gate re-exposes 1:1. */
export type CheckoutToolName =
  | 'create_checkout'
  | 'get_checkout'
  | 'update_checkout'
  | 'complete_checkout'
  | 'cancel_checkout';

export const CHECKOUT_TOOL_NAMES: readonly CheckoutToolName[] = [
  'create_checkout',
  'get_checkout',
  'update_checkout',
  'complete_checkout',
  'cancel_checkout',
] as const;

/** Flattened, matcher-friendly facts for AgentGate policy evaluation. */
export interface CheckoutFacts {
  /** The "total" entry's amount, in minor units. */
  totals_total_minor: number;
  currency: string | undefined;
  line_count: number;
  line_item_ids: string[];
}
