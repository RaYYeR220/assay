import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, type Address, type Hex } from 'viem';
import type { AssayAddresses } from './types.ts';

/** The JSON `script/Deploy.s.sol` writes to `assay/deployments/<chainId>.json`. */
export interface Deployment {
  chainId: number;
  assayOracle: Address;
  assetRegistry: Address;
  attestationRegistry: Address;
  assayVault?: Address;
  currency?: Address;
  quoteAdapter?: Address;
  assetId?: Hex;
  assetKey?: string;
  /** Not written by the deploy script; supply it to bound log scans. */
  startBlock?: number;
}

export class DeploymentNotFoundError extends Error {
  readonly chainId: number;
  readonly searched: string[];

  constructor(chainId: number, searched: string[]) {
    super(
      `no deployment file for chain ${chainId}. Looked in:\n  ${searched.join('\n  ')}\n` +
        'Set ASSAY_DEPLOYMENTS_DIR, or pass addresses to the client explicitly.',
    );
    this.name = 'DeploymentNotFoundError';
    this.chainId = chainId;
    this.searched = searched;
  }
}

function candidateDirs(explicit?: string): string[] {
  const dirs: string[] = [];
  if (explicit) dirs.push(resolve(explicit));
  if (process.env['ASSAY_DEPLOYMENTS_DIR']) dirs.push(resolve(process.env['ASSAY_DEPLOYMENTS_DIR']));

  // Walk up from both the caller's cwd and this module, so the package works from a repo
  // checkout, from node_modules inside that checkout, and from an installed copy.
  const roots = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const root of roots) {
    let dir = resolve(root);
    for (let i = 0; i < 8; i++) {
      dirs.push(join(dir, 'deployments'));
      dirs.push(join(dir, 'assay', 'deployments'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...new Set(dirs)];
}

/** Load deployed addresses, or throw a message that says where it looked. */
export function loadDeployment(chainId: number, options: { dir?: string } = {}): Deployment {
  const found = tryLoadDeployment(chainId, options);
  if (!found) throw new DeploymentNotFoundError(chainId, candidateDirs(options.dir).map((d) => join(d, `${chainId}.json`)));
  return found;
}

/** Same, but absent config is a normal answer rather than an exception. */
export function tryLoadDeployment(chainId: number, options: { dir?: string } = {}): Deployment | null {
  for (const dir of candidateDirs(options.dir)) {
    const path = join(dir, `${chainId}.json`);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const deployment = normalise(chainId, parsed);
    if (deployment) return deployment;
  }
  return null;
}

function normalise(chainId: number, raw: Record<string, unknown>): Deployment | null {
  const pick = (...keys: string[]): Address | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string' && isAddress(value)) return value as Address;
    }
    return undefined;
  };

  const oracle = pick('assayOracle', 'oracle', 'AssayOracle');
  const assetRegistry = pick('assetRegistry', 'assets', 'AssetRegistry');
  const attestationRegistry = pick('attestationRegistry', 'attestations', 'AttestationRegistry');
  if (!oracle || !assetRegistry || !attestationRegistry) return null;

  const deployment: Deployment = {
    chainId: typeof raw['chainId'] === 'number' ? raw['chainId'] : chainId,
    assayOracle: oracle,
    assetRegistry,
    attestationRegistry,
  };
  const vault = pick('assayVault', 'vault', 'AssayVault');
  if (vault) deployment.assayVault = vault;
  const currency = pick('currency', 'settlementToken');
  if (currency) deployment.currency = currency;
  const adapter = pick('quoteAdapter', 'adapter');
  if (adapter) deployment.quoteAdapter = adapter;
  if (typeof raw['assetId'] === 'string') deployment.assetId = raw['assetId'] as Hex;
  if (typeof raw['assetKey'] === 'string') deployment.assetKey = raw['assetKey'];
  if (typeof raw['startBlock'] === 'number') deployment.startBlock = raw['startBlock'];
  return deployment;
}

export function addressesFrom(deployment: Deployment): AssayAddresses {
  const addresses: AssayAddresses = {
    oracle: deployment.assayOracle,
    assetRegistry: deployment.assetRegistry,
    attestationRegistry: deployment.attestationRegistry,
  };
  if (deployment.assayVault) addresses.vault = deployment.assayVault;
  if (deployment.currency) addresses.currency = deployment.currency;
  if (deployment.quoteAdapter) addresses.quoteAdapter = deployment.quoteAdapter;
  return addresses;
}
