#!/usr/bin/env node
/**
 * @assay/mcp — a read-only MCP server over the Assay NAV oracle.
 *
 * Every tool here reads. None of them holds a key, signs anything, or sends a transaction,
 * and there is no code path by which one could: the client is constructed without a wallet.
 * That is a deliberate boundary rather than an omission — an agent that can consult an
 * oracle and an agent that can move value against it are different trust decisions, and
 * mixing them into one server takes the choice away from whoever installs it.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ServerContext } from './context.ts';
import { registerAssetTools } from './tools/assets.ts';
import { registerBundleTool } from './tools/bundle.ts';
import { registerRoundTools } from './tools/rounds.ts';

export function createServer(context = new ServerContext(loadConfig())): McpServer {
  const server = new McpServer(
    { name: 'assay', version: '0.1.0' },
    {
      instructions:
        'Assay is a NAV oracle on OKX X Layer for real-world assets that no price feed covers. ' +
        'Five language models running in Intel TDX enclaves appraise the asset; the contract re-verifies ' +
        'each enclave attestation on chain, rebuilds the exact request and response bytes, checks the ' +
        'signature and parses the answer strictly, and publishes a price only when a quorum agrees within ' +
        'a band on fresh evidence. Otherwise it records a HALT and every consumer is frozen. ' +
        'When get_nav returns a refusal, that is the system working: report the reason, do not substitute ' +
        'an estimate of your own or a price from elsewhere. Use explain_round to see why a round failed, ' +
        'and verify_bundle to check a set of signed answers before anyone pays gas. This server is ' +
        'read-only and cannot sign or send anything.',
    },
  );

  registerAssetTools(server, context);
  registerRoundTools(server, context);
  registerBundleTool(server, context);

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(new ServerContext(config));

  // stdout carries the protocol, so anything human-readable has to go to stderr.
  process.stderr.write(
    `assay-mcp: chain ${config.chainId} via ${config.rpcUrl}` +
      (config.addresses.oracle ? `, oracle ${config.addresses.oracle}\n` : ', no oracle address configured yet\n'),
  );

  await server.connect(new StdioServerTransport());
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/index.js') ||
  process.argv[1]?.replace(/\\/g, '/').endsWith('/index.ts');

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`assay-mcp failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  });
}

export { loadConfig, ServerContext };
