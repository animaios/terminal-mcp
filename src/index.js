#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionManager } from './session-manager.js';
import { registerTools } from './tools.js';
import { PtydProcess } from './ptyd-process.js';
import { PtydClient } from './ptyd-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

const log = (msg) => process.stderr.write(`[smart-terminal-mcp] ${msg}\n`);

/**
 * Create a sandbox server with an externally-provided ptydClient.
 * Useful for tests and embedding.
 * @param {object} [opts]
 * @param {import('./ptyd-client.js').PtydClient} [opts.ptydClient]
 */
export function createSandboxServer(opts = {}) {
  const server = new McpServer({
    name: 'smart-terminal-mcp',
    version,
  });
  const manager = new SessionManager({ ptydClient: opts.ptydClient });
  registerTools(server, manager);
  return { server, manager };
}
export default createSandboxServer;

async function main() {
  // 1. Spawn ptyd daemon
  const ptyd = new PtydProcess();
  const { socketPath } = await ptyd.start();
  log(`ptyd daemon started (socket: ${socketPath})`);

  // 2. Connect JS client to daemon
  const ptydClient = new PtydClient(socketPath);
  await ptydClient.connect();
  log('Connected to ptyd daemon');

  // 3. Create session manager with client
  const manager = new SessionManager({ ptydClient: ptydClient });

  // 4. MCP server setup
  const server = new McpServer({
    name: 'smart-terminal-mcp',
    version,
  });
  registerTools(server, manager);

  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down, cleaning up sessions...');
    manager.destroyAll();
    await ptyd.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    manager.destroyAll();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('Server started on stdio transport');
}

// Skip auto-start when imported by Smithery scanner or other bundlers
const scriptPath = (process.argv[1] || '').replace(/\\/g, '/');
const isScanning = Boolean(process.env.SMITHERY_SCAN) || scriptPath.includes('.smithery') || scriptPath.includes('/scan-');

if (!isScanning) {
  main().catch((err) => {
    process.stderr.write(`[smart-terminal-mcp] Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}

