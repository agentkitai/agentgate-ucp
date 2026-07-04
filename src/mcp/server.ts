import type { MerchantClient } from '../merchant/client';

/**
 * The gate's MCP server: re-exposes the 5 UCP checkout tools 1:1, passing through
 * to the merchant EXCEPT `complete_checkout`, which runs the policy/approval gate.
 *
 * TODO(#8): build the @modelcontextprotocol/sdk Server + StreamableHTTP transport,
 *           register the 5 tools, and wire dispatch (gate on complete_checkout).
 */
export interface GateServerDeps {
  merchant: MerchantClient;
}

export function createGateServer(_deps: GateServerDeps): never {
  throw new Error('createGateServer not implemented (task #8)');
}
