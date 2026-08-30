/**
 * AgentEnvelope MCP server: the MCP adapter for AgentEnvelope.
 *
 * Any MCP client can call these tools to verify delegated action authority
 * before the runtime executes a real action. Sovereign verification is local
 * and free. Hosted governance uses API-key protected AgentEnvelope routes for
 * records, legitimacy, delegates, verification reports, and mint receipts.
 */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AgentEnvelopeClient } from 'agent-envelope-sdk/client';
import { verifyAction as verifyActionSovereign, verifyRecord as verifyRecordSovereign } from 'agent-envelope-sdk';

const HOSTED_BASE_URL = process.env.AE_API_BASE_URL?.trim() || 'https://jemdjwteae.execute-api.us-east-1.amazonaws.com/v1';
const SERVER_VERSION = '1.1.0';
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
const DELEGATE_ID = /^ae-delegate-[a-zA-Z0-9_-]{8,128}$/;
const LEGITIMACY_ID = /^ae-legit-[a-zA-Z0-9_-]{8,128}$/;
const SAFE_TEXT_ID = /^[a-zA-Z0-9_:.*/-]{1,256}$/;

const hostedClients = new Map();

function getApiKey(extra) {
  const bearer = extra?.authInfo?.token?.trim();
  return bearer || process.env.AE_API_KEY?.trim() || null;
}

function governanceClient(extra) {
  const apiKey = getApiKey(extra);
  if (!apiKey) return null;
  if (!hostedClients.has(apiKey)) hostedClients.set(apiKey, new AgentEnvelopeClient({ apiKey }));
  return hostedClients.get(apiKey);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

function summaryText(value) {
  if (isPlainObject(value)) {
    if ('allowed' in value) return value.allowed ? 'AgentEnvelope allowed the action.' : 'AgentEnvelope denied the action.';
    if ('valid' in value) return value.valid ? 'AgentEnvelope verification passed.' : 'AgentEnvelope verification failed.';
    if ('delegateId' in value) return `AgentEnvelope delegate result: ${value.delegateId}`;
    if ('legitimacyId' in value) return `AgentEnvelope legitimacy result: ${value.legitimacyId}`;
  }
  return JSON.stringify(value, null, 2);
}

function ok(value, text = summaryText(value)) {
  return {
    content: [{ type: 'text', text }],
    ...(isPlainObject(value) ? { structuredContent: value } : {}),
  };
}

function fail(message, details) {
  return {
    content: [{ type: 'text', text: message }],
    ...(details && isPlainObject(details) ? { structuredContent: details } : {}),
    isError: true,
  };
}

function hostedResult(value, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    return fail(`${fallback}: ${String(value.error)}`, value);
  }
  return ok(value);
}

function errorBody(err) {
  if (err && typeof err === 'object' && 'body' in err && err.body && typeof err.body === 'object') return err.body;
  return null;
}

async function hostedJson(path, init, extra) {
  const apiKey = getApiKey(extra);
  if (!apiKey) throw new Error(NEEDS_KEY);
  const res = await fetch(HOSTED_BASE_URL + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `AgentEnvelope API error ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token?.trim()) return null;
  return token.trim();
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}

function decisionFromReport(report, input) {
  const reportValid = Boolean(report?.valid);
  const operationMatches = !input.operation || !report?.envelope?.operation || report.envelope.operation === input.operation;
  const resourceMatches = !input.resource || !Array.isArray(report?.envelope?.resources) || resourceAllowed(report.envelope.resources, input.resource);
  const valid = reportValid && operationMatches && resourceMatches;
  const reason = valid
    ? 'verified'
    : !reportValid
      ? (report?.reason || report?.legitimacyReason || 'verification_failed')
      : !operationMatches
        ? 'operation_mismatch'
        : 'resource_mismatch';
  return {
    type: 'agentenvelope.authorizationDecision',
    version: 1,
    allowed: valid,
    decision: valid ? 'allowed' : 'denied',
    reason,
    message: valid ? 'AgentEnvelope verified authority for this action.' : `AgentEnvelope denied this action: ${reason}`,
    agentId: input.agentId,
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.actionIndex !== undefined ? { actionIndex: input.actionIndex } : {}),
    checkedAt: report?.checkedAt ?? new Date().toISOString(),
    ...(report?.recordId ? { recordId: report.recordId } : {}),
    ...(report?.actionEnvelopeHash ? { actionEnvelopeHash: report.actionEnvelopeHash } : {}),
    ...(report?.expectedActionEnvelopeHash ? { expectedActionEnvelopeHash: report.expectedActionEnvelopeHash } : {}),
    ...(report?.legitimacyRef ? { legitimacyRef: report.legitimacyRef } : {}),
    report,
  };
}

function resourceAllowed(allowedResources, resource) {
  const prefix = resource.split(':')[0];
  return allowedResources.some((allowed) => allowed === resource || allowed === `${prefix}:*` || allowed === '*');
}

const signedMessageSchema = jsonWithin(MAX_SIGNED_MESSAGE_BYTES, 'signed message');
const mintObjectSchema = jsonWithin(MAX_MINT_OBJECT_BYTES, 'mint object');
const agentIdSchema = z.string().regex(AGENT_ID, 'agentId must be 1-128 characters: letters, numbers, underscore, colon, or hyphen');
const addressSchema = z.string().regex(ADDRESS, 'address must be a 0x-prefixed 20-byte hex address');
const hashSchema = z.string().regex(HASH, 'hash must be a 0x-prefixed 32-byte hex value');
const signatureSchema = z.string().regex(SIGNATURE, 'signature must be a 0x-prefixed 65-byte recoverable signature');
const delegateIdSchema = z.string().regex(DELEGATE_ID, 'delegateId must be an ae-delegate id');
const legitimacyIdSchema = z.string().regex(LEGITIMACY_ID, 'legitimacyId must be an ae-legit id');
const operationSchema = z.string().regex(SAFE_TEXT_ID, 'operation contains unsupported characters');
const resourceSchema = z.string().regex(SAFE_TEXT_ID, 'resource contains unsupported characters');

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

const readOnlyLocal = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const readOnlyHosted = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const governedHosted = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function createServer() {
  const server = new McpServer({ name: 'agent-envelope', version: SERVER_VERSION });

  server.registerTool(
    'ae_verify_sovereign',
    {
      title: 'Verify signature (sovereign, offline)',
      description:
        'Signature-only check: verify a signed message against a known agent address. Pure crypto, no vault, no API key, no network. This does not check scope, expiry, usage limits, or hosted record status.',
      annotations: readOnlyLocal,
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
        'Verify a signed action against a public action record. Checks record status, action index, signature/address match, optional expected envelope hash, and time decay. No API key or network call.',
      annotations: readOnlyLocal,
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

  server.registerTool(
    'ae_get_agent',
    {
      title: 'Look up registered agent',
      description: 'Fetch the hosted public record for an agent id. Requires a portal-issued API key.',
      annotations: readOnlyHosted,
      inputSchema: {
        agentId: agentIdSchema.describe('The registered agent id'),
      },
    },
    async ({ agentId }, extra) => {
      const client = governanceClient(extra);
      if (!client) return fail(NEEDS_KEY);
      try {
        return hostedResult(await client.getAgent(agentId), 'lookup failed');
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'lookup failed', errorBody(err));
      }
    },
  );

  server.registerTool(
    'ae_verify_action',
    {
      title: 'Verify action (hosted record)',
      description: 'Verify a signed action against the hosted public record for an agent. Requires a portal-issued API key.',
      annotations: readOnlyHosted,
      inputSchema: {
        agentId: agentIdSchema.describe('The registered agent id'),
        actionIndex: z.number().int().nonnegative().describe('The action index'),
        payload: signedMessageSchema.describe('The signed action payload'),
        signature: signatureSchema.describe('0x-prefixed 65-byte signature'),
        expectedActionEnvelopeHash: hashSchema.optional().describe('Optional expected action-envelope hash'),
      },
    },
    async ({ agentId, actionIndex, payload, signature, expectedActionEnvelopeHash }, extra) => {
      const client = governanceClient(extra);
      if (!client) return fail(NEEDS_KEY);
      try {
        return hostedResult(await client.verifyAction({ agentId, actionIndex, payload, signature, expectedActionEnvelopeHash }), 'verification failed');
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'verification failed', errorBody(err));
      }
    },
  );

  server.registerTool(
    'ae_authorize_action',
    {
      title: 'Authorize action (hosted decision)',
      description:
        'One-call AgentEnvelope decision for a proposed agent action. It normalizes hosted verification into allowed/denied and checks optional operation/resource labels against the verified record envelope when present.',
      annotations: readOnlyHosted,
      inputSchema: {
        agentId: agentIdSchema.describe('The registered agent id'),
        operation: operationSchema.optional().describe('The proposed operation, for decision context and audit readability'),
        resource: resourceSchema.optional().describe('The proposed resource, for decision context and audit readability'),
        actionIndex: z.number().int().nonnegative().describe('The action index'),
        payload: signedMessageSchema.describe('The exact signed action payload'),
        signature: signatureSchema.describe('0x-prefixed 65-byte signature'),
        expectedActionEnvelopeHash: hashSchema.optional().describe('Optional expected action-envelope hash'),
      },
    },
    async (input, extra) => {
      const client = governanceClient(extra);
      if (!client) return fail(NEEDS_KEY);
      try {
        const report = await client.verifyAction(input);
        return ok(decisionFromReport(report, input));
      } catch (err) {
        const body = errorBody(err);
        return ok({
          type: 'agentenvelope.authorizationDecision',
          version: 1,
          allowed: false,
          decision: 'denied',
          reason: body?.code || body?.error || (err instanceof Error ? err.message : 'verification_failed'),
          message: body?.message || (err instanceof Error ? err.message : 'AgentEnvelope denied this action.'),
          agentId: input.agentId,
          ...(input.operation ? { operation: input.operation } : {}),
          ...(input.resource ? { resource: input.resource } : {}),
          actionIndex: input.actionIndex,
          checkedAt: new Date().toISOString(),
          ...(body ? { report: body } : {}),
        });
      }
    },
  );

  server.registerTool(
    'ae_get_delegate',
    {
      title: 'Get mint delegate',
      description: 'Fetch one active hosted mint delegate by delegate id. Returns an error if the delegate is revoked. Requires a portal-issued API key.',
      annotations: readOnlyHosted,
      inputSchema: {
        delegateId: delegateIdSchema.describe('The hosted delegate id'),
      },
    },
    async ({ delegateId }, extra) => {
      try {
        return hostedResult(await hostedJson('/sovereign/delegates/' + encodeURIComponent(delegateId), { method: 'GET' }, extra), 'delegate lookup failed');
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'delegate lookup failed', errorBody(err));
      }
    },
  );

  server.registerTool(
    'ae_check_legitimacy',
    {
      title: 'Check legitimacy state',
      description: 'Fetch and normalize a hosted legitimacy state. Returns allowed when the state is legitimate and not expired. Requires a portal-issued API key.',
      annotations: readOnlyHosted,
      inputSchema: {
        legitimacyId: legitimacyIdSchema.describe('The hosted legitimacy id'),
      },
    },
    async ({ legitimacyId }, extra) => {
      const client = governanceClient(extra);
      if (!client) return fail(NEEDS_KEY);
      try {
        const result = await client.getLegitimacyState(legitimacyId);
        const state = result?.legitimacy ?? result?.state ?? result;
        const expiresAt = state?.expiresAt;
        const expired = Boolean(expiresAt && Date.parse(expiresAt) <= Date.now());
        const allowed = state?.status === 'legitimate' && !expired;
        return ok({
          type: 'agentenvelope.legitimacyDecision',
          version: 1,
          legitimacyId,
          allowed,
          decision: allowed ? 'allowed' : 'denied',
          status: state?.status ?? 'unknown',
          ...(expired ? { reason: 'legitimacy policy expired' } : {}),
          checkedAt: new Date().toISOString(),
          state,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'legitimacy check failed', errorBody(err));
      }
    },
  );

  server.registerTool(
    'ae_mint',
    {
      title: 'Verify mint request (hosted receipt)',
      description:
        'Verify a MintDelegate and signed MintRequest through hosted governance. Returns a mint receipt; it does not return private capability material. Requires a portal-issued API key. This is a governed action.',
      annotations: governedHosted,
      inputSchema: {
        delegate: mintObjectSchema.describe('The signed MintDelegate'),
        request: mintObjectSchema.describe('The bot-signed MintRequest'),
      },
    },
    async ({ delegate, request }, extra) => {
      const client = governanceClient(extra);
      if (!client) return fail(NEEDS_KEY);
      try {
        return hostedResult(await client.mint({ delegate, request }), 'mint failed');
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'mint failed', errorBody(err));
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

/** Build the server and expose it over Streamable HTTP. */
export async function startHttp({ port = 8787, host = '127.0.0.1', path = '/mcp' } = {}) {
  const transports = new Map();

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

      if (url.pathname === '/health') {
        jsonResponse(res, 200, { ok: true, name: 'agent-envelope', transport: 'streamable-http' });
        return;
      }

      if (url.pathname !== path) {
        jsonResponse(res, 404, { error: 'not found' });
        return;
      }

      const token = extractBearer(req);
      if (token) req.auth = { token, clientId: 'bearer', scopes: ['agent-envelope'] };

      const rawSessionId = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) {
          jsonResponse(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: initialize before using this MCP session' },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => transports.set(id, transport),
        });

        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };

        const mcpServer = createServer();
        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        jsonResponse(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal server error' },
          id: null,
        });
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  console.error(`AgentEnvelope MCP server ready on http://${host}:${port}${path}`);
  return httpServer;
}
