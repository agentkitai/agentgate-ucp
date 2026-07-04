/**
 * The gate's MCP server: re-exposes the 5 UCP checkout tools 1:1, passing every
 * call straight through to the merchant.
 *
 * Task #8 is a PURE passthrough spine — no policy/approval gate yet. The gate on
 * `complete_checkout` lands in task #9; for now all five tools forward directly.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { dispatchToolCall, isCheckoutToolName, TOOL_DEFINITIONS } from '../mapping';
import type { MerchantClient } from '../merchant/client';

export interface GateServerDeps {
  merchant: MerchantClient;
}

/**
 * Build a fresh MCP `Server` wired to the given merchant client. In the
 * StreamableHTTP stateless setup one of these is created per request.
 */
export function createGateServer({ merchant }: GateServerDeps): Server {
  const server = new Server(
    { name: 'agentgate-ucp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // List the 5 UCP checkout tools.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Dispatch each call by name to the merchant (pure passthrough).
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!isCheckoutToolName(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return dispatchToolCall(merchant, name, args ?? {});
  });

  return server;
}
