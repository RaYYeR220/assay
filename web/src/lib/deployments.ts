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
