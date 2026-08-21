/**
 * chain.ts — the small amount of chain state the backend must read before posting.
 *
 * Two facts decide whether a round can land at all, and neither is knowable from the
 * gateway response:
 *
 *   1. `AssetRegistry.evidenceAllowed(assetId, sha256(evidence))` — the issuer must have
 *      committed the evidence digest first. Without this, anyone could invent evidence, buy
 *      genuine enclave signatures over it, and move the NAV at will: deflate, subscribe,
 *      inflate, redeem, vault drained in one transaction. So the commitment is mandatory
 *      and `postAppraisal` reverts with `EvidenceNotCommitted` when it is missing.
 *
 *   2. `AssayOracle.observationWatermark(assetId)` — a verdict whose `created` is at or
 *      before the last accepted round is Stale, so a replayed or slow round is rejected.
 *
 * Reads are OPTIONAL. With no RPC configured every value comes back `null`, which the
 * preflight reports as UNKNOWN — never as fine. Guessing "probably committed" is exactly
 * the failure this module exists to prevent.
 */

import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem';

export const RPC_URL = process.env.ASSAY_RPC_URL ?? '';
export const ASSET_REGISTRY = (process.env.ASSAY_ASSET_REGISTRY ?? '') as Address;
export const ASSAY_ORACLE = (process.env.ASSAY_ORACLE ?? '') as Address;

export const ASSET_REGISTRY_ABI = parseAbi([
  'function evidenceAllowed(bytes32 assetId, bytes32 evidenceHash) view returns (bool)',
  'function commitEvidence(bytes32 assetId, bytes32 evidenceHash, string uri, bool allowed)',
  'function modelAt(bytes32 assetId, uint256 slot) view returns (string)',
  'function buildRequest(bytes32 assetId, uint256 slot, bytes evidence) view returns (bytes)',
]);

export const ASSAY_ORACLE_ABI = parseAbi([
  'function observationWatermark(bytes32 assetId) view returns (uint64)',
  'function epochOf(bytes32 assetId) view returns (uint32)',
]);

export function chainConfigured(): boolean {
  return Boolean(RPC_URL && ASSET_REGISTRY);
}

let cached: PublicClient | null = null;
export function publicClient(): PublicClient | null {
  if (!RPC_URL) return null;
  cached ??= createPublicClient({ transport: http(RPC_URL) }) as PublicClient;
  return cached;
}

export interface ChainPrecheck {
  /** null when it could not be read — treat as UNKNOWN, never as true. */
  evidenceCommitted: boolean | null;
  observationWatermark: number | null;
  epoch: number | null;
  configured: boolean;
  error: string | null;
}

/**
 * Read the two round-gating facts. Never throws: a precheck that blows up must not take
 * down an appraisal that is otherwise fine to record locally.
 */
export async function precheckRound(assetIdHex: `0x${string}`, evidenceHashHex: `0x${string}`): Promise<ChainPrecheck> {
  const out: ChainPrecheck = {
    evidenceCommitted: null,
    observationWatermark: null,
    epoch: null,
    configured: chainConfigured(),
    error: null,
  };
  const client = publicClient();
  if (!client || !ASSET_REGISTRY) {
    out.error = 'no RPC configured (set ASSAY_RPC_URL and ASSAY_ASSET_REGISTRY) — commitment state is UNKNOWN';
    return out;
  }
  try {
    out.evidenceCommitted = await client.readContract({
      address: ASSET_REGISTRY,
      abi: ASSET_REGISTRY_ABI,
      functionName: 'evidenceAllowed',
      args: [assetIdHex, evidenceHashHex],
    });
  } catch (e) {
    out.error = `evidenceAllowed read failed: ${(e as Error).message}`;
  }
  if (ASSAY_ORACLE) {
    try {
      const [w, ep] = await Promise.all([
        client.readContract({ address: ASSAY_ORACLE, abi: ASSAY_ORACLE_ABI, functionName: 'observationWatermark', args: [assetIdHex] }),
        client.readContract({ address: ASSAY_ORACLE, abi: ASSAY_ORACLE_ABI, functionName: 'epochOf', args: [assetIdHex] }),
      ]);
      out.observationWatermark = Number(w);
      out.epoch = Number(ep);
    } catch (e) {
      out.error = `${out.error ? out.error + '; ' : ''}oracle read failed: ${(e as Error).message}`;
    }
  }
  return out;
}

/**
 * The exact call the ISSUER must make before a round can post. Returned as data rather than
 * executed: the backend holds no issuer key, and it should not pretend to.
 */
export function commitEvidenceCall(assetIdHex: `0x${string}`, evidenceHashHex: `0x${string}`, uri = '') {
  return {
    to: ASSET_REGISTRY || '(set ASSAY_ASSET_REGISTRY)',
    abi: 'AssetRegistry',
    functionName: 'commitEvidence',
    args: [assetIdHex, evidenceHashHex, uri, true],
    signature: 'commitEvidence(bytes32,bytes32,string,bool)',
    note: 'Must be sent by the asset issuer. Until it lands, postAppraisal reverts with EvidenceNotCommitted.',
  };
}
