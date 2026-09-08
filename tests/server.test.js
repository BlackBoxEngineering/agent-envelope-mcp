import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decisionFromReport } from '../src/server.js';

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
  assert.ok(spawnedToolNames(env).includes('ae_mint'));
});

test('AE_TOOLS=readonly omits mint tool', () => {
  assert.equal(spawnedToolNames({ ...process.env, AE_TOOLS: 'readonly' }).includes('ae_mint'), false);
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
