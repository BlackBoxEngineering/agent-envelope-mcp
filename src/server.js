/**
 * AgentEnvelope MCP server — the neutral authority layer for action-performing systems.
 *
 * Any MCP client (Claude, an OpenAI agent, LangChain, CrewAI, a custom runtime)
 * can call these tools to check and issue delegated action authority without
 * building its own policy engine, audit log, or verification stack.
 * AgentEnvelope is owned by no framework, so every framework can embed it.
 *
 * Two tiers of tools, matching the two modes:
 *
 *   Sovereign (free, offline, no credential):
 *     - ae_verify_sovereign   verify a signature against a known agent address
 *
 *   Hosted governance (requires AE_API_KEY):
 *     - ae_get_agent          look up a registered agent's public record
 *     - ae_verify_action      verify a signed action against the hosted record
 *     - ae_mint               verify a mint request through hosted governance
 *
 * Verification in sovereign mode is always free. The hosted-governance tools
 * are what a framework offloads rather than rebuilds. API keys meter hosted
 * service routes; signatures prove authority.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AgentEnvelopeClient } from 'agent-envelope-sdk/client';
import { verifyAction as verifyActionSovereign } from 'agent-envelope-sdk';

// ─── Credential handling (fail-closed, never process.exit inside a server) ────

function getApiKey() {
  return process.env.AE_API_KEY?.trim() || null;
}

let cachedClient = null;
function governanceClient() {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (!cachedClient) cachedClient = new AgentEnvelopeClient({ apiKey });
  return cachedClient;
}

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const NEEDS_KEY =
  'AE_API_KEY is not set. This is a hosted-governance tool; set the portal-issued API key to use it. (Sovereign verification needs no key — use ae_verify_sovereign.)';

/**
 * Build a fully configured AgentEnvelope MCP server (not yet connected to a
 * transport). Exported so hosts can mount it on their own transport.
 */
export function createServer() {
  const server = new McpServer({ name: 'agent-envelope', version: '1.0.4' });

  // Sovereign — free, offline, no credential.
  server.registerTool(
    'ae_verify_sovereign',
    {
      title: 'Verify (sovereign, offline)',
      description:
        'Verify a signed message against a known agent address. Pure crypto, no vault, no API key, no network. Verification is always free.',
      inputSchema: {
        message: z.record(z.string(), z.unknown()).describe('The exact signed message object'),
        signature: z.string().describe('0x-prefixed 65-byte signature'),
        expectedAddress: z.string().describe("The agent's 0x address to check against"),
      },
    },
    async ({ message, signature, expectedAddress }) => {
      try {
        return ok(verifyActionSovereign({ message, signature, expectedAddress }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'verification failed');
      }
    },
  );

  // Hosted governance — requires AE_API_KEY.
  server.registerTool(
    'ae_get_agent',
    {
      title: 'Look up registered agent',
      description: 'Fetch the hosted public record for an agent id. Requires a portal-issued API key.',
      inputSchema: {
        agentId: z.string().describe('The registered agent id'),
      },
    },
    async ({ agentId }) => {
      const client = governanceClient();
      if (!client) return fail(NEEDS_KEY);
      try {
        return ok(await client.getAgent(agentId));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'lookup failed');
      }
    },
  );

  server.registerTool(
    'ae_verify_action',
    {
      title: 'Verify action (hosted record)',
      description: 'Verify a signed action against the hosted public record for an agent. Requires a portal-issued API key.',
      inputSchema: {
        agentId: z.string().describe('The registered agent id'),
        actionIndex: z.number().int().nonnegative().describe('The action index'),
        payload: z.record(z.string(), z.unknown()).describe('The signed action payload'),
        signature: z.string().describe('0x-prefixed 65-byte signature'),
        expectedActionEnvelopeHash: z.string().optional().describe('Optional expected action-envelope hash'),
      },
    },
    async ({ agentId, actionIndex, payload, signature, expectedActionEnvelopeHash }) => {
      const client = governanceClient();
      if (!client) return fail(NEEDS_KEY);
      try {
        return ok(await client.verifyAction({ agentId, actionIndex, payload, signature, expectedActionEnvelopeHash }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'verification failed');
      }
    },
  );

  server.registerTool(
    'ae_mint',
    {
      title: 'Mint capability (governance event)',
      description:
        'Verify a MintDelegate and signed MintRequest through hosted governance. Returns a mint receipt. Requires a portal-issued API key. This is a governed action.',
      inputSchema: {
        delegate: z.record(z.string(), z.unknown()).describe('The signed MintDelegate'),
        request: z.record(z.string(), z.unknown()).describe('The bot-signed MintRequest'),
      },
    },
    async ({ delegate, request }) => {
      const client = governanceClient();
      if (!client) return fail(NEEDS_KEY);
      try {
        return ok(await client.mint({ delegate, request }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'mint failed');
      }
    },
  );

  return server;
}

/** Build the server and connect it over stdio. */
export async function start() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('AgentEnvelope MCP server ready on stdio.');
}
