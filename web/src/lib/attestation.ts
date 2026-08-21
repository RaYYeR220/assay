import type { Address, Hex } from 'viem';
import { ATTESTATIONS } from '@/generated/data';

/**
 * The trust root, as the dashboard displays it.
 *
 * On a live deployment this is assembled from `SignerAttested` logs plus `signerInfo` reads.
 * In replay mode it comes from a recorded snapshot with the same shape, so the attestation
 * view looks identical with or without a chain connection.
 */

/** One `registerSigner` call: this key, bound to this model, in this transaction. */
export interface ModelRegistration {
  model: string;
  modelIdHash: Hex;
  txHash: Hex;
  blockNumber: string;
  quoteBytes?: number | null;
}

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
  /** Whether this measurement is still on the registry's allowlist. */
  imageAllowed?: boolean;
  /** Models this key is permitted to answer for. */
  models: string[];
  /** Each binding, with the transaction that made it. */
  registrations?: ModelRegistration[];
  /** Transaction in which the quote was verified. */
  txHash: Hex;
  blockNumber: string;
  quoteBytes?: number | null;
  gpuArch?: string;
  /** The 64 bytes the enclave bound into its quote, hex without prefix. */
  reportData?: string | null;
}

/** A measurement the registry will accept a quote for, and the transaction that allowed it. */
export interface AllowedImage {
  measurement: Hex;
  allowed: boolean;
  txHash: Hex;
  blockNumber: string;
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
  capturedAtBlock?: string;
  adapter: {
    address: Address;
    /** Contract name as it appears on the explorer. */
    label: string;
    /** False for the non-verifying stand-in. Surfaced as a loud warning. */
    isTrusted: boolean;
  };
  attestationTtlSec: number;
  signerOffset: number;
  /** The committee seats this deployment appraises with, as the asset registry lists them. */
  committee?: string[];
  allowedImages?: AllowedImage[];
  signers: AttestedSigner[];
}

/**
 * The recorded trust root for a network, or null where nothing has been captured for it.
 *
 * Keyed by chain so a snapshot taken on one network can never be shown as another's. A network
 * with no record shows as having none, which is the honest answer before a deployment exists.
 */
export function attestationFor(chainId: number): AttestationSnapshot | null {
  return ATTESTATIONS[chainId] ?? null;
}

/**
 * How many enclaves actually stand behind the committee.
 *
 * A committee of five models is not a committee of five enclaves unless five distinct keys
 * signed. Where one attested key fronts several seats, that is a real limit on what the
 * attestation proves, and the view states it rather than letting five model names imply five
 * independent machines.
 */
export function enclaveIndependence(snapshot: AttestationSnapshot): {
  keys: number;
  seats: number;
  /** True when fewer keys than seats — one enclave answering for several models. */
  shared: boolean;
  /** The single measurement behind every key, when they all run the same image. */
  sharedMeasurement: Hex | null;
} {
  const live = snapshot.signers.filter((s) => !s.revoked);
  const seats = new Set(live.flatMap((s) => s.models)).size;
  const measurements = new Set(live.map((s) => s.mrTd));
  return {
    keys: live.length,
    seats,
    shared: live.length > 0 && live.length < seats,
    sharedMeasurement: measurements.size === 1 ? (live[0]?.mrTd ?? null) : null,
  };
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
