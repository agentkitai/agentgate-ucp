/**
 * Maps an MCP `tools/call` for the five UCP checkout tools onto the merchant's
 * REST client, and wraps the merchant Checkout back into an MCP `CallToolResult`.
 *
 * This is the PURE 1:1 passthrough layer (task #8): no policy/approval gate yet
 * (that lands in task #9 for `complete_checkout`). Every tool call is forwarded
 * to the merchant unchanged.
 *
 * Tool args follow checkout-mcp.md: `{ meta, id?, checkout? }` where
 *   - `meta['ucp-agent']`      → `UCP-Agent` header (required on every op)
 *   - `meta['idempotency-key']`→ `Idempotency-Key` header (required for complete/cancel)
 *   - `id`                     → the target checkout id (get/update/complete/cancel)
 *   - `checkout`               → the domain payload (create/update/complete)
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { MerchantClient, MerchantError } from './merchant/client';
import type { MerchantHeaders } from './merchant/client';
import type { Checkout, CheckoutToolName } from './types';
import { CHECKOUT_TOOL_NAMES } from './types';

/**
 * Serialise the `meta['ucp-agent']` value into the `UCP-Agent` structured-header
 * string the merchant parses (e.g. `profile="https://…", version="2026-01-01"`).
 * Strings pass through untouched; objects become `key="value"` pairs.
 */
export function formatUcpAgent(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'object') {
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
        parts.push(`${key}="${raw}"`);
      }
    }
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return undefined;
}

/** Pull the `UCP-Agent` + `Idempotency-Key` header values out of a tool call's `meta`. */
export function extractHeaders(meta: unknown): MerchantHeaders {
  if (!meta || typeof meta !== 'object') return {};
  const m = meta as Record<string, unknown>;
  const idempotencyKey = m['idempotency-key'];
  return {
    ucpAgent: formatUcpAgent(m['ucp-agent']),
    idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
  };
}

/** Wrap a merchant Checkout into the MCP result shape (structuredContent + text). */
export function wrapCheckout(checkout: Checkout): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(checkout) }],
    structuredContent: checkout as { [key: string]: unknown },
  };
}

/** Build an `isError` result carrying a human-readable message (never throws). */
export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Type guard: is `name` one of the five UCP checkout tools? */
export function isCheckoutToolName(name: string): name is CheckoutToolName {
  return (CHECKOUT_TOOL_NAMES as readonly string[]).includes(name);
}

const META_PROPERTY = {
  type: 'object',
  description:
    "Request metadata. `ucp-agent` identifies the platform agent (required on every request); `idempotency-key` is a UUID required for complete/cancel.",
  properties: {
    'ucp-agent': {
      type: 'object',
      description: 'Platform agent identification (e.g. { "profile": "https://…" }).',
    },
    'idempotency-key': {
      type: 'string',
      description: 'Unique key for retry safety.',
    },
  },
  additionalProperties: true,
} as const;

const ID_PROPERTY = {
  type: 'string',
  description: 'The id of the target checkout session.',
} as const;

const CHECKOUT_PROPERTY = {
  type: 'object',
  description: 'The checkout session payload (domain data + optional extensions).',
  additionalProperties: true,
} as const;

/** The five UCP checkout tool definitions, mirroring checkout-mcp.md. */
export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'create_checkout',
    description: 'Create a checkout session.',
    inputSchema: {
      type: 'object',
      properties: { meta: META_PROPERTY, checkout: CHECKOUT_PROPERTY },
      required: ['meta', 'checkout'],
    },
  },
  {
    name: 'get_checkout',
    description: 'Get a checkout session.',
    inputSchema: {
      type: 'object',
      properties: { meta: META_PROPERTY, id: ID_PROPERTY },
      required: ['meta', 'id'],
    },
  },
  {
    name: 'update_checkout',
    description: 'Update a checkout session.',
    inputSchema: {
      type: 'object',
      properties: { meta: META_PROPERTY, id: ID_PROPERTY, checkout: CHECKOUT_PROPERTY },
      required: ['meta', 'id', 'checkout'],
    },
  },
  {
    name: 'complete_checkout',
    description: 'Place the order (finalise the checkout with payment data).',
    inputSchema: {
      type: 'object',
      properties: {
        meta: {
          ...META_PROPERTY,
          required: ['ucp-agent', 'idempotency-key'],
        },
        id: ID_PROPERTY,
        checkout: CHECKOUT_PROPERTY,
      },
      required: ['meta', 'id', 'checkout'],
    },
  },
  {
    name: 'cancel_checkout',
    description: 'Cancel a checkout session.',
    inputSchema: {
      type: 'object',
      properties: {
        meta: {
          ...META_PROPERTY,
          required: ['ucp-agent', 'idempotency-key'],
        },
        id: ID_PROPERTY,
      },
      required: ['meta', 'id'],
    },
  },
];

export function requireId(id: unknown, tool: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${tool} requires a string "id" argument`);
  }
  return id;
}

/**
 * Dispatch a checkout tool call to the merchant and wrap the result. Merchant
 * (and argument) errors are converted to `isError` results — this never throws.
 */
export async function dispatchToolCall(
  merchant: MerchantClient,
  name: CheckoutToolName,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const headers = extractHeaders(args['meta']);
  const checkout = args['checkout'];
  const id = args['id'];

  try {
    let result: Checkout;
    switch (name) {
      case 'create_checkout':
        result = await merchant.createCheckout(checkout, headers);
        break;
      case 'get_checkout':
        result = await merchant.getCheckout(requireId(id, name), headers);
        break;
      case 'update_checkout':
        result = await merchant.updateCheckout(requireId(id, name), checkout, headers);
        break;
      case 'complete_checkout':
        result = await merchant.completeCheckout(requireId(id, name), checkout, headers);
        break;
      case 'cancel_checkout':
        result = await merchant.cancelCheckout(requireId(id, name), headers);
        break;
      default: {
        const exhaustive: never = name;
        return errorResult(`Unknown tool: ${String(exhaustive)}`);
      }
    }
    return wrapCheckout(result);
  } catch (err) {
    if (err instanceof MerchantError) {
      return errorResult(err.message);
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
