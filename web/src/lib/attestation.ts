import type { Address, Hex } from 'viem';

/**
 * The trust root, as the dashboard displays it.
 *
 * On a live deployment this is assembled from `SignerAttested` logs plus `signerInfo` reads.
 * In replay mode it comes from a recorded snapshot with the same shape, so the attestation
 * view looks identical with or without a chain connection.
 */

export interface AttestedSigner {
  /** The address the enclave bound into its own quote's report data. */
  address: Address;
  /** Measurement of the trust domain — the image the enclave is running. */
  mrTd: Hex;
  /** Intel TCB evaluation ordinal for the platform that produced the quote. */
  tcbStatus: number;
  tcbStatusLabel: string;
  /** Unix seconds at which the quote was verified on chain. */
  attestedAt: number;
  revoked: boolean;
  /** Models this key is permitted to answer for. */
  models: string[];
  /** Transaction in which the quote was verified. */
  txHash: Hex;
  blockNumber: string;
  quoteBytes?: number;
  gpuArch?: string;
  /** The 64 bytes the enclave bound into its quote, hex without prefix. */
  reportData?: string;
}

export interface AttestationSnapshot {
  chainId: number;
  /**
   * Where this came from. A fixture is a worked example with fabricated keys; it must never be
   * presented as the trust root of a live network, so the view checks this before anything else.
   */
  source?: 'live' | 'fixture';
  /** Unix seconds this snapshot was taken. */
  capturedAt: number;
  adapter: {
    address: Address;
    /** Contract name as it appears on the explorer. */
    label: string;
    /** False for the non-verifying stand-in. Surfaced as a loud warning. */
    isTrusted: boolean;
  };
  attestationTtlSec: number;
  signerOffset: number;
  signers: AttestedSigner[];
}

/**
 * Intel TCB statuses, in the ordinal order the DCAP verifier reports them. Anything other
 * than `UpToDate` is a platform the operator has to justify.
 */
export const TCB_STATUS_LABELS: Record<number, string> = {
  0: 'UpToDate',
  1: 'OutOfDate',
  2: 'SWHardeningNeeded',
  3: 'ConfigurationNeeded',
  4: 'ConfigurationAndSWHardeningNeeded',
  5: 'OutOfDateConfigurationNeeded',
  6: 'Revoked',
};

export function tcbLabel(status: number): string {
  return TCB_STATUS_LABELS[status] ?? `Unknown(${status})`;
}

/** Only `UpToDate` is unremarkable; everything else earns a caution mark in the readout. */
export function tcbIsClean(status: number): boolean {
  return status === 0;
}

export interface AttestationLife {
  expiresAt: number;
  remainingSec: number;
  expired: boolean;
  /** Fraction of the TTL already elapsed, clamped to 0..1. */
  elapsed: number;
}

export function attestationLife(
  signer: AttestedSigner,
  ttlSec: number,
  nowSec: number,
): AttestationLife {
  const expiresAt = signer.attestedAt + ttlSec;
  const remainingSec = expiresAt - nowSec;
  return {
    expiresAt,
    remainingSec,
    expired: remainingSec <= 0,
    elapsed: Math.min(1, Math.max(0, (nowSec - signer.attestedAt) / ttlSec)),
  };
}
