import {
  AssayClient,
  addressesFrom,
  chainById,
  explainRevert,
  tryLoadDeployment,
  type AssayAddresses,
  type Deployment,
} from '@assay/sdk';
import { createPublicClient, http, isAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';

export interface ServerConfig {
  chainId: number;
  rpcUrl: string;
  addresses: AssayAddresses;
  deployment: Deployment | null;
  fromBlock: bigint;
}

/**
 * Configuration comes entirely from the environment, because an MCP server is launched by a
 * client that has no other way to talk to it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const chainId = Number(env['ASSAY_CHAIN_ID'] ?? 196);
  const chain = chainById(chainId);
  const deployment = tryLoadDeployment(
    chainId,
    env['ASSAY_DEPLOYMENTS_DIR'] ? { dir: env['ASSAY_DEPLOYMENTS_DIR'] } : {},
  );

  const override = (key: string): Address | undefined => {
    const value = env[key];
    return value && isAddress(value) ? (value as Address) : undefined;
  };

  const addresses: AssayAddresses = {
    ...(deployment ? addressesFrom(deployment) : {}),
  } as AssayAddresses;

  const oracle = override('ASSAY_ORACLE');
  if (oracle) addresses.oracle = oracle;
  const assetRegistry = override('ASSAY_ASSET_REGISTRY');
  if (assetRegistry) addresses.assetRegistry = assetRegistry;
  const attestationRegistry = override('ASSAY_ATTESTATION_REGISTRY');
  if (attestationRegistry) addresses.attestationRegistry = attestationRegistry;
  const vault = override('ASSAY_VAULT');
  if (vault) addresses.vault = vault;

  return {
    chainId,
    rpcUrl: env['ASSAY_RPC_URL'] ?? chain.rpcUrls.default.http[0],
    addresses,
    deployment,
    fromBlock: env['ASSAY_FROM_BLOCK'] ? BigInt(env['ASSAY_FROM_BLOCK']) : 0n,
  };
}

export class NotConfiguredError extends Error {
  constructor(what: string, chainId: number) {
    super(
      `no ${what} address for chain ${chainId}. Set ASSAY_ORACLE / ASSAY_ASSET_REGISTRY / ` +
        'ASSAY_ATTESTATION_REGISTRY, or point ASSAY_DEPLOYMENTS_DIR at a directory holding ' +
        `${chainId}.json. Assay may not be deployed on this chain yet.`,
    );
    this.name = 'NotConfiguredError';
  }
}

/**
 * The client is built once and reused. Nothing here ever holds a key: the wallet argument
 * of AssayClient is deliberately never supplied, so no tool in this server can sign.
 */
export class ServerContext {
  readonly config: ServerConfig;
  private client: AssayClient | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  assay(): AssayClient {
    if (this.client) return this.client;
    if (!this.config.addresses.oracle) throw new NotConfiguredError('AssayOracle', this.config.chainId);

    const chain = chainById(this.config.chainId);
    this.client = new AssayClient({
      publicClient: createPublicClient({ chain, transport: http(this.config.rpcUrl) }),
      addresses: this.config.addresses,
      chainId: this.config.chainId,
      startBlock: this.config.fromBlock,
    });
    return this.client;
  }

  /** An asset id, from either a bytes32 or the string key it was listed under. */
  resolveAssetId(input: { assetId?: string; assetKey?: string }): Hex {
    if (input.assetId) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(input.assetId)) {
        throw new Error(`assetId must be a 32-byte hex string, got ${input.assetId}`);
      }
      return input.assetId as Hex;
    }
    if (input.assetKey) return keccak256(stringToHex(input.assetKey));
    if (this.config.deployment?.assetId) return this.config.deployment.assetId;
    throw new Error('pass assetId (bytes32) or assetKey (the string it was listed under)');
  }
}

/** BigInt is not JSON, and a silently dropped price is worse than a string one. */
export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

export interface ToolResult {
  // The MCP SDK's callback type is an open record; without the index signature TypeScript
  // refuses to widen a closed interface into it.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: json(payload) }] };
}

/**
 * Turn a thrown error into data.
 *
 * A halted oracle is the system working, so a tool must not surface it as a protocol error
 * the client might retry or hide. Only a genuine misconfiguration is worth flagging, and
 * even that comes back as readable JSON.
 */
export function failure(error: unknown, hint?: string): ToolResult {
  const refusal = explainRevert((error as { cause?: unknown })?.cause ?? error);
  const configuration = error instanceof NotConfiguredError || error instanceof TypeError;
  return {
    content: [
      {
        type: 'text',
        text: json({
          ok: false,
          reason: configuration ? 'not-configured' : refusal.reason,
          detail: configuration ? (error as Error).message : refusal.detail,
          ...(refusal.error ? { solidityError: refusal.error } : {}),
          ...(refusal.args ? { args: refusal.args } : {}),
          ...(hint ? { hint } : {}),
        }),
      },
    ],
  };
}
