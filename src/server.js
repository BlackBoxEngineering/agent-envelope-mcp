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
 *     - ae_verify_sovereign          verify a signature against a known agent address
 *     - ae_verify_sovereign_record   verify a signature against a public action record
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
import { verifyAction as verifyActionSovereign, verifyRecord as verifyRecordSovereign } from 'agent-envelope-sdk';

// ─── Credential handling (fail-closed, never process.exit inside a server) ────

function getApiKey() {
  return process.env.AE_API_KEY?.trim() || null;
}

let cachedClient = null;
let cachedApiKey = null;
function governanceClient() {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new AgentEnvelopeClient({ apiKey });
    cachedApiKey = apiKey;
  }
  return cachedClient;
}

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const hostedResult = (value, fallback) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    return fail(`${fallback}: ${String(value.error)}`);
  }
  return ok(value);
};
const NEEDS_KEY =
  'AE_API_KEY is not set. This is a hosted-governance tool; set the portal-issued API key to use it. Sovereign signature and record verification need no key.';

const encoder = new TextEncoder();
const MAX_SIGNED_MESSAGE_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_MINT_OBJECT_BYTES = 256 * 1024;
const AGENT_ID = /^[a-zA-Z0-9_:-]{1,128}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^0x[a-fA-F0-9]{64}$/;
const SIGNATURE = /^0x[a-fA-F0-9]{130}$/;

function jsonByteLength(value) {
  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    return Infinity;
  }
}

function jsonWithin(maxBytes, label) {
  return z.unknown().refine((value) => jsonByteLength(value) <= maxBytes, {
    message: `${label} exceeds ${maxBytes} JSON bytes`,
  });
}

const signedMessageSchema = jsonWithin(MAX_SIGNED_MESSAGE_BYTES, 'signed message');
const mintObjectSchema = jsonWithin(MAX_MINT_OBJECT_BYTES, 'mint object');
const agentIdSchema = z.string().regex(AGENT_ID, 'agentId must be 1-128 characters: letters, numbers, underscore, colon, or hyphen');
const addressSchema = z.string().regex(ADDRESS, 'address must be a 0x-prefixed 20-byte hex address');
const hashSchema = z.string().regex(HASH, 'hash must be a 0x-prefixed 32-byte hex value');
const signatureSchema = z.string().regex(SIGNATURE, 'signature must be a 0x-prefixed 65-byte recoverable signature');
const publicActionRecordSchema = z.object({
  type: z.literal('agentenvelope.publicActionRecord'),
  version: z.literal(1),
  recordId: z.string().min(1).max(256),
  agentId: agentIdSchema,
  agentAddress: addressSchema,
  status: z.string().min(1).max(32),
  domain: z.object({
    domainId: z.string().min(1).max(128),
    domainHash: hashSchema,
  }).passthrough(),
  actionEnvelope: z.object({
    actionIndex: z.number().int().nonnegative(),
  }).passthrough(),
  actionEnvelopeHash: hashSchema,
  expiry: z.string().nullable().optional(),
}).passthrough().refine((value) => jsonByteLength(value) <= MAX_RECORD_BYTES, {
  message: `public action record exceeds ${MAX_RECORD_BYTES} JSON bytes`,
});

/**
 * Build a fully configured AgentEnvelope MCP server (not yet connected to a
 * transport). Exported so hosts can mount it on their own transport.
 */
export function createServer() {
  const server = new McpServer({ name: 'agent-envelope', version: '1.0.6' });

  // Sovereign — free, offline, no credential.
  server.registerTool(
    'ae_verify_sovereign',
    {
      title: 'Verify signature (sovereign, offline)',
      description:
        'Signature-only check: verify a signed message against a known agent address. Pure crypto, no vault, no API key, no network. This does not check an action envelope, scope, expiry, or usage limits; use ae_verify_sovereign_record when you have a public action record.',
      inputSchema: {
        message: signedMessageSchema.describe('The exact signed message value'),
        signature: signatureSchema.describe('0x-prefixed 65-byte signature'),
        expectedAddress: addressSchema.describe("The agent's 0x address to check against"),
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

  server.registerTool(
    'ae_verify_sovereign_record',
    {
      title: 'Verify public action record (sovereign, offline)',
      description:
        'Verify a signed action against a public action record. Checks record status, action index, signature/address match, optional expected envelope hash, and time decay. Pure crypto/local validation with no API key and no network.',
      inputSchema: {
        record: publicActionRecordSchema.describe('The public action record received from AgentEnvelope or another trusted store'),
        actionIndex: z.number().int().nonnegative().describe('The action index being invoked'),
        payload: signedMessageSchema.describe('The exact signed action payload'),
        signature: signatureSchema.describe('0x-prefixed 65-byte signature'),
        expectedActionEnvelopeHash: hashSchema.optional().describe('Optional expected action-envelope hash'),
      },
    },
    async ({ record, actionIndex, payload, signature, expectedActionEnvelopeHash }) => {
      try {
        return ok(verifyRecordSovereign(record, { payload, signature, actionIndex, expectedActionEnvelopeHash }));
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'record verification failed');
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
        agentId: agentIdSchema.describe('The registered agent id'),
      },
    },
    async ({ agentId }) => {
      const client = governanceClient();
      if (!client) return fail(NEEDS_KEY);
      try {
        return hostedResult(await client.getAgent(agentId), 'lookup failed');
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
        agentId: agentIdSchema.describe('The registered agent id'),
        actionIndex: z.number().int().nonnegative().describe('The action index'),
        payload: signedMessageSchema.describe('The signed action payload'),
        signature: signatureSchema.describe('0x-prefixed 65-byte signature'),
        expectedActionEnvelopeHash: hashSchema.optional().describe('Optional expected action-envelope hash'),
      },
    },
    async ({ agentId, actionIndex, payload, signature, expectedActionEnvelopeHash }) => {
      const client = governanceClient();
      if (!client) return fail(NEEDS_KEY);
      try {
        return hostedResult(await client.verifyAction({ agentId, actionIndex, payload, signature, expectedActionEnvelopeHash }), 'verification failed');
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'verification failed');
      }
    },
  );

  server.registerTool(
    'ae_mint',
    {
      title: 'Verify mint request (hosted receipt)',
      description:
        'Verify a MintDelegate and signed MintRequest through hosted governance. Returns a mint receipt; it does not return private capability material. Requires a portal-issued API key. This is a governed action.',
      inputSchema: {
        delegate: mintObjectSchema.describe('The signed MintDelegate'),
        request: mintObjectSchema.describe('The bot-signed MintRequest'),
      },
    },
    async ({ delegate, request }) => {
      const client = governanceClient();
      if (!client) return fail(NEEDS_KEY);
      try {
        return hostedResult(await client.mint({ delegate, request }), 'mint failed');
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
