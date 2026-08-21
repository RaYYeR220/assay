import type { Address, Hex } from 'viem';
import { DEPLOYMENTS } from '@/generated/data';
import { isSupportedChainId, type SupportedChainId } from './chains';

/**
 * A deployment manifest, written by `script/Deploy.s.sol` into `deployments/<chainId>.json`.
 * Absent until the contracts are deployed, which the dashboard treats as a first-class state
 * rather than an error.
 */
export interface Deployment {
  chainId: number;
  quoteAdapter: Address;
  attestationRegistry: Address;
  assetRegistry: Address;
  assayOracle: Address;
  assayVault: Address;
  currency: Address;
  assetKey: string;
  assetId: Hex;

  /**
   * First block of the deployment. X Layer caps `eth_getLogs` at a hundred blocks, so anything
   * that reads history scans forward from here rather than backwards from head.
   */
  startBlock?: number;
  /** The on-chain DCAP verifier the quote adapter defers to, when there is one. */
  dcapAttestation?: Address;
  /** Explorer root, as the deploy script recorded it. */
  explorer?: string;
  /** Further assets registered on the same contracts, when the deployment carries them. */
  assetKeyV2?: string;
  assetIdV2?: Hex;
  assayVaultV2?: Address;

  /**
   * The manifest is written by the deploy script, not by this application, and it gains keys as
   * the deployment grows. Anything the dashboard does not read is carried through untouched
   * rather than rejected, so a new field in the manifest can never fail the build.
   */
  [key: string]: unknown;
}

export function deploymentFor(chainId: number): Deployment | null {
  return DEPLOYMENTS[chainId] ?? null;
}

export function deployedChainIds(): SupportedChainId[] {
  return Object.keys(DEPLOYMENTS)
    .map(Number)
    .filter(isSupportedChainId);
}

export function hasAnyDeployment(): boolean {
  return Object.keys(DEPLOYMENTS).length > 0;
}
