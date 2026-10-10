import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, decisionFromReport } from '../src/server.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function spawnedToolNames(env) {
  return execFileSync(
    process.execPath,
    [
      '-e',
      "import('./src/server.js').then(({createServer})=>console.log(Object.keys(createServer()._registeredTools||{}).sort().join(',')))",
    ],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
    },
  ).trim().split(',').filter(Boolean);
}

test('registers mint tool by default', () => {
  const { AE_TOOLS: _aeTools, ...env } = process.env;
  const names = spawnedToolNames(env);
  assert.ok(names.includes('ae_mint'));
  assert.ok(names.includes('ae_register_delegated_action'));
});

test('AE_TOOLS=readonly omits mint tool', () => {
  const names = spawnedToolNames({ ...process.env, AE_TOOLS: 'readonly' });
  assert.equal(names.includes('ae_mint'), false);
  assert.equal(names.includes('ae_register_delegated_action'), false);
});

test('delegated action registration uses the hosted registration route', async () => {
  const previousKey = process.env.AE_API_KEY;
  const previousFetch = globalThis.fetch;
  let request;
  process.env.AE_API_KEY = 'test-api-key';
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recordId: 'ae-action-test' }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const server = createServer();
    const result = await server._registeredTools.ae_register_delegated_action.handler({
      record: { recordId: 'ae-action-test' },
      request: { requestId: 'request-test' },
      delegateId: 'ae-delegate-test0001',
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.recordId, 'ae-action-test');
    assert.ok(request.url.endsWith('/sovereign/agents/register-delegated'));
    assert.equal(request.init.headers['X-Api-Key'], 'test-api-key');
    assert.deepEqual(JSON.parse(request.init.body), {
      record: { recordId: 'ae-action-test' },
      request: { requestId: 'request-test' },
      delegateId: 'ae-delegate-test0001',
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AE_API_KEY;
    else process.env.AE_API_KEY = previousKey;
  }
});

test('delegated action registration accepts the canonical domain projection over MCP', async () => {
  const previousKey = process.env.AE_API_KEY;
  const previousFetch = globalThis.fetch;
  let called = false;
  process.env.AE_API_KEY = 'test-api-key';
  globalThis.fetch = async () => {
    called = true;
    return new Response(JSON.stringify({ recordId: 'ae-action-test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const server = createServer();
  const client = new Client({ name: 'domain-projection-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const domainHash = `0x${'1'.repeat(64)}`;
    const domainAddress = `0x${'2'.repeat(40)}`;
    const actionEnvelopeHash = `0x${'3'.repeat(64)}`;
    const result = await client.callTool({
      name: 'ae_register_delegated_action',
      arguments: {
        record: {
          type: 'agentenvelope.publicActionRecord',
          version: 1,
          recordId: 'ae-action-test',
          agentId: 'mobile:device-01:0',
          agentAddress: `0x${'4'.repeat(40)}`,
          status: 'active',
          domain: {
            domainInfo: {
              type: 'agentenvelope.domainInfo',
              version: 1,
              namespace: 'mobile-testing',
              domainId: 'hmgcc-mobile-mimic',
              kind: 'device',
            },
            canonicalDomainInfo: '{}',
            domainHash,
            domainAddress,
            domainFingerprint: 'ae-domain-test',
            createdAt: '2026-09-26T15:51:06.679Z',
          },
          actionEnvelope: { actionIndex: 0 },
          actionEnvelopeHash,
          expiry: null,
        },
        request: { requestId: 'request-test' },
        delegateId: 'ae-delegate-test0001',
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(called, true);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AE_API_KEY;
    else process.env.AE_API_KEY = previousKey;
  }
});

test('decisionFromReport fails closed when operation is requested but absent from report envelope', () => {
  const decision = decisionFromReport(
    { valid: true, envelope: { resources: ['refund:123'] } },
    { agentId: 'agent-1', actionIndex: 0, operation: 'refund', resource: 'refund:123' },
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'operation_missing');
});

test('decisionFromReport fails closed when resource is requested but absent from report envelope', () => {
  const decision = decisionFromReport(
    { valid: true, envelope: { operation: 'refund' } },
    { agentId: 'agent-1', actionIndex: 0, operation: 'refund', resource: 'refund:123' },
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'resources_missing');
});

test('decisionFromReport allows matching operation and resource', () => {
  const decision = decisionFromReport(
    { valid: true, envelope: { operation: 'refund', resources: ['refund:*'] } },
    { agentId: 'agent-1', actionIndex: 0, operation: 'refund', resource: 'refund:123' },
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'verified');
});
