#!/usr/bin/env node
import { start } from '../src/server.js';

start().catch((err) => {
  console.error('AgentEnvelope MCP server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
