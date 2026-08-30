#!/usr/bin/env node
import { start, startHttp } from '../src/server.js';

function readFlagValue(names, fallback) {
  for (const name of names) {
    const index = process.argv.indexOf(name);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
  }
  return fallback;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

const wantsHttp = process.argv.includes('--http') || process.argv.includes('http');
const run = wantsHttp
  ? () => startHttp({
      port: parsePort(readFlagValue(['--port', '-p'], process.env.PORT || '8787')),
      host: readFlagValue(['--host'], process.env.HOST || '127.0.0.1'),
      path: readFlagValue(['--path'], process.env.MCP_PATH || '/mcp'),
    })
  : start;

run().catch((err) => {
  console.error('AgentEnvelope MCP server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
