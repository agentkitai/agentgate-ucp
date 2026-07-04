/**
 * The gate's MCP server: re-exposes the 5 UCP checkout tools.
 *
 * Four tools (create/get/update/cancel) are a PURE 1:1 passthrough to the
 * merchant. `complete_checkout` is GATED (task #9): when a {@link Gate} is
 * provided it evaluates the checkout against AgentGate spend policy before
 * placing the order. With no gate the server is a pure passthrough (task #8
 * behaviour), so the passthrough tests keep working unchanged.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import type { Gate } from '../gate/agentgate';
import { gateCompleteCheckout } from '../gate/complete';
import { dispatchToolCall, isCheckoutToolName, TOOL_DEFINITIONS } from '../mapping';
import type { MerchantClient } from '../merchant/client';
import type { ParkedSessionStore } from '../store/parked';

export interface GateServerDeps {
  merchant: MerchantClient;
  /** Optional policy gate. When absent, `complete_checkout` is pure passthrough. */
  gate?: Gate | undefined;
  /** Optional parked-session store. When present, a `pending` decision is parked (task #10). */
  store?: ParkedSessionStore | undefined;
}

/**
 * Build a fresh MCP `Server` wired to the given merchant client (and optional
 * gate). In the StreamableHTTP stateless setup one of these is created per request.
 */
export function createGateServer({ merchant, gate, store }: GateServerDeps): Server {
  const server = new Server(
    { name: 'agentgate-ucp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // List the 5 UCP checkout tools.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Dispatch each call by name. `complete_checkout` runs through the policy gate
  // when one is configured; every other tool is forwarded straight through.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!isCheckoutToolName(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    if (name === 'complete_checkout' && gate) {
      return gateCompleteCheckout(merchant, gate, args ?? {}, {}, store);
    }
    return dispatchToolCall(merchant, name, args ?? {});
  });

  return server;
}
