/**
 * The off-chain half of what AssayOracle does on chain.
 *
 * Everything here is a deliberate mirror of Solidity, so an integrator can run the whole
 * check before spending gas and know the answer will be the same. The order of the checks
 * matches `_checkVerdict` and `_parseResponse` exactly; where the contract returns a
 * `RejectReason` instead of reverting, so does this.
 */

import { bytesToHex, hexToBytes, recoverMessageAddress, sha256, type Address, type Hex } from 'viem';
import type { RejectReason } from './enums.ts';

export type BytesLike = Uint8Array | Hex;

/** The response grammar, mirroring AssayOracle's owner-settable byte patterns. */
export interface Grammar {
  contentPrefix: string;
  confidenceInfix: string;
  contentSuffix: string;
  finishPattern: string;
  createdPattern: string;
}

export const DEFAULT_GRAMMAR: Grammar = {
  contentPrefix: '"content":"ASSAY1|nav_usd_e6=',
  confidenceInfix: '|confidence_bps=',
  contentSuffix: '"',
  finishPattern: '"finish_reason":"stop"',
  createdPattern: '"created":',
};

/** Bounds enforced by the contract. */
export const MAX_EVIDENCE_BYTES = 8192;
export const MAX_RESPONSE_BYTES = 16_384;
export const MAX_NAV_E6 = 1_000_000_000_000_000_000_000_000n;
export const BPS = 10_000;

/** EIP-191 prefix for the fixed-length payload the enclave signs. */
export const EIP191_PREFIX_129 = '\x19Ethereum Signed Message:\n129';

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function toBytes(value: BytesLike): Uint8Array {
  return typeof value === 'string' ? hexToBytes(value) : value;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------------------

/**
 * Rebuild the exact request bytes an enclave in one committee slot was asked to answer:
 * `head || modelId || mid || evidence || tail`.
 *
 * Byte-for-byte identical to `AssetRegistry.buildRequest`. The fragments come from the
 * registry, not from this package, because the question itself is on chain.
 */
export function buildRequestBytes(
  head: BytesLike,
  modelId: string,
  mid: BytesLike,
  evidence: string | Uint8Array,
  tail: BytesLike,
): Uint8Array {
  return concat([
    toBytes(head),
    utf8Bytes(modelId),
    toBytes(mid),
    typeof evidence === 'string' ? utf8Bytes(evidence) : evidence,
    toBytes(tail),
  ]);
}

/** Prompt fragments as stored in AssetRegistry, and exported to schema.appraisal.v1.json. */
export interface PromptSchema {
  head: Hex;
  mid: Hex;
  tail: Hex;
  schemaId?: Hex;
}

export function buildRequestFromSchema(
  schema: PromptSchema,
  modelId: string,
  evidence: string | Uint8Array,
): Uint8Array {
  return buildRequestBytes(schema.head, modelId, schema.mid, evidence, schema.tail);
}

/**
 * Mirrors `Ascii.isJsonStringSafe`: printable ASCII only, no quote, no backslash.
 *
 * The charset is narrowed at registration rather than trusted at appraisal time because
 * the evidence is interpolated into a JSON document the contract rebuilds verbatim.
 */
export function isJsonStringSafe(value: string | Uint8Array): boolean {
  const bytes = typeof value === 'string' ? utf8Bytes(value) : value;
  for (const byte of bytes) {
    if (byte < 0x20 || byte === 0x22 || byte === 0x5c || byte > 0x7e) return false;
  }
  return true;
}

/** The offending byte, for an error message worth reading. */
export function firstUnsafeByte(value: string | Uint8Array): { index: number; byte: number } | null {
  const bytes = typeof value === 'string' ? utf8Bytes(value) : value;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte < 0x20 || byte === 0x22 || byte === 0x5c || byte > 0x7e) return { index: i, byte };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// The signed text
// ---------------------------------------------------------------------------------------

export function sha256Hex(input: BytesLike | string): string {
  const bytes = typeof input === 'string' && !input.startsWith('0x') ? utf8Bytes(input) : toBytes(input as BytesLike);
  return sha256(bytes).slice(2);
}

/**
 * `sha256hex(request) + ":" + sha256hex(response)` — exactly 129 ASCII characters, which is
 * why the contract can hardcode the EIP-191 length prefix.
 */
export function signedText(requestBytes: Uint8Array, responseBytes: Uint8Array): string {
  const text = `${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
  if (text.length !== 129) throw new Error(`signed text must be 129 characters, got ${text.length}`);
  return text;
}

/** The exact preimage the contract keccak256s. */
export function eip191Preimage(text: string): string {
  if (text.length !== 129) throw new Error(`expected a 129-character signed text, got ${text.length}`);
  return EIP191_PREFIX_129 + text;
}

/**
 * Recover the enclave key that signed a request/response pair.
 *
 * Returns null instead of throwing on a malformed signature, matching the contract, which
 * treats an unrecoverable signature as a rejected verdict rather than a failed round.
 */
export async function recoverEnclaveSigner(
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  signature: Hex,
): Promise<Address | null> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return await recoverMessageAddress({
      message: signedText(requestBytes, responseBytes),
      signature,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Offsets
// ---------------------------------------------------------------------------------------

export interface VerdictOffsets {
  contentOffset: number;
  finishOffset: number;
  createdOffset: number;
}

export class OffsetNotFoundError extends Error {
  readonly field: keyof VerdictOffsets;
  readonly pattern: string;

  constructor(field: keyof VerdictOffsets, pattern: string) {
    super(`response body contains no ${JSON.stringify(pattern)}, so ${field} cannot be located`);
    this.name = 'OffsetNotFoundError';
    this.field = field;
    this.pattern = pattern;
  }
}

function indexOfPattern(haystack: Uint8Array, pattern: string): number {
  const needle = utf8Bytes(pattern);
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function matchAt(haystack: Uint8Array, offset: number, pattern: string): boolean {
  const needle = utf8Bytes(pattern);
  if (offset < 0 || !Number.isInteger(offset) || offset + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[offset + i] !== needle[i]) return false;
  }
  return true;
}

/**
 * Locate the three literals inside the raw response bytes.
 *
 * Diagnostic only. These offsets are no longer submitted: they used to ride outside the
 * signed payload, so anyone replaying a round could corrupt them and force a halt, and the
 * contract now scans for the patterns itself. Locating them is still the fastest way to see
 * why a response will not parse.
 *
 * Found by scanning, never assumed: gateways reorder JSON keys and pad usage objects, so a
 * hardcoded offset would be wrong the first time anything upstream changed. The chain
 * treats these as untrusted hints and re-matches the literal at the offset given, so a bad
 * hint costs a rejection, not a misread — but a correct hint is what gets an honest answer
 * counted.
 */
export function findOffsets(responseBytes: Uint8Array, grammar: Grammar = DEFAULT_GRAMMAR): VerdictOffsets {
  const contentOffset = indexOfPattern(responseBytes, grammar.contentPrefix);
  if (contentOffset < 0) throw new OffsetNotFoundError('contentOffset', grammar.contentPrefix);
  const finishOffset = indexOfPattern(responseBytes, grammar.finishPattern);
  if (finishOffset < 0) throw new OffsetNotFoundError('finishOffset', grammar.finishPattern);
  const createdOffset = indexOfPattern(responseBytes, grammar.createdPattern);
  if (createdOffset < 0) throw new OffsetNotFoundError('createdOffset', grammar.createdPattern);
  return { contentOffset, finishOffset, createdOffset };
}

/** Offsets when they exist, zeros when they do not, so a bad answer can still be submitted. */
export function findOffsetsOrZero(
  responseBytes: Uint8Array,
  grammar: Grammar = DEFAULT_GRAMMAR,
): VerdictOffsets {
  try {
    return findOffsets(responseBytes, grammar);
  } catch {
    return { contentOffset: 0, finishOffset: 0, createdOffset: 0 };
  }
}

// ---------------------------------------------------------------------------------------
// The strict parser
// ---------------------------------------------------------------------------------------

export interface ParsedVerdict {
  navE6: bigint;
  confidenceBps: number;
  createdAt: number;
  offsets: VerdictOffsets;
}

export interface ParseOutcome {
  ok: boolean;
  reason: RejectReason;
  detail: string | null;
  parsed: ParsedVerdict | null;
}

/** Mirrors `Ascii.readUint`: a run of ASCII digits, at most 30 of them, no sign, no decimal. */
function readUint(bytes: Uint8Array, offset: number): { value: bigint; next: number; ok: boolean } {
  let i = offset;
  let value = 0n;
  let digits = 0;
  while (i < bytes.length) {
    const c = bytes[i]!;
    if (c < 0x30 || c > 0x39) break;
    value = value * 10n + BigInt(c - 0x30);
    i++;
    digits++;
    if (digits > 30) return { value: 0n, next: offset, ok: false };
  }
  if (digits === 0) return { value: 0n, next: offset, ok: false };
  return { value, next: i, ok: true };
}

/**
 * Run the on-chain parse over a response body and report the same `RejectReason` the
 * contract would. Returns a reason rather than throwing, because one broken committee
 * member must never take the round down.
 */
export function parseResponse(
  responseBytes: Uint8Array,
  offsets?: VerdictOffsets,
  grammar: Grammar = DEFAULT_GRAMMAR,
): ParseOutcome {
  const fail = (reason: RejectReason, detail: string): ParseOutcome => ({
    ok: false,
    reason,
    detail,
    parsed: null,
  });

  if (responseBytes.length === 0) return fail('Malformed', 'the committee member returned nothing');
  if (responseBytes.length > MAX_RESPONSE_BYTES) {
    return fail('Malformed', `response body is ${responseBytes.length} bytes, over the ${MAX_RESPONSE_BYTES} limit`);
  }

  let off: VerdictOffsets;
  if (offsets) {
    off = offsets;
  } else {
    try {
      off = findOffsets(responseBytes, grammar);
    } catch (error) {
      const field = (error as OffsetNotFoundError).field;
      return fail(
        field === 'finishOffset' ? 'Truncated' : 'Malformed',
        (error as Error).message,
      );
    }
  }

  if (!matchAt(responseBytes, off.finishOffset, grammar.finishPattern)) {
    return fail('Truncated', 'the generation did not finish cleanly; finish_reason was not "stop"');
  }
  if (!matchAt(responseBytes, off.createdOffset, grammar.createdPattern)) {
    return fail('Malformed', 'no "created": timestamp at the offset given');
  }

  const created = readUint(responseBytes, off.createdOffset + grammar.createdPattern.length);
  if (!created.ok || created.value > 0xffff_ffff_ffff_ffffn) {
    return fail('Malformed', 'the "created" field is not a uint64');
  }

  if (!matchAt(responseBytes, off.contentOffset, grammar.contentPrefix)) {
    return fail('Malformed', 'the answer does not open with the exact ASSAY1 marker line');
  }

  let p = off.contentOffset + grammar.contentPrefix.length;
  const nav = readUint(responseBytes, p);
  if (!nav.ok) return fail('Malformed', 'nav_usd_e6 is not an integer');
  p = nav.next;

  if (!matchAt(responseBytes, p, grammar.confidenceInfix)) {
    return fail('Malformed', 'missing |confidence_bps= immediately after nav_usd_e6');
  }
  p += grammar.confidenceInfix.length;

  const confidence = readUint(responseBytes, p);
  if (!confidence.ok) return fail('Malformed', 'confidence_bps is not an integer');
  p = confidence.next;

  // The closing quote has to come immediately after the number. Anything else is commentary,
  // and commentary is what this oracle refuses to price on.
  if (!matchAt(responseBytes, p, grammar.contentSuffix)) {
    return fail('Malformed', 'the model added text after confidence_bps');
  }

  if (nav.value === 0n || nav.value > MAX_NAV_E6 || confidence.value > BigInt(BPS)) {
    return fail('OutOfRange', `nav_usd_e6=${nav.value} confidence_bps=${confidence.value}`);
  }

  return {
    ok: true,
    reason: 'None',
    detail: null,
    parsed: {
      navE6: nav.value,
      confidenceBps: Number(confidence.value),
      createdAt: Number(created.value),
      offsets: off,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Whole-verdict check
// ---------------------------------------------------------------------------------------

/**
 * The `Verdict` tuple the contract takes.
 *
 * The three offset fields are legacy. They used to be submitted as hints, but they rode
 * outside the signed payload, so anyone replaying a round could corrupt them and force a
 * halt; the contract now scans for the patterns itself. They are still filled in here
 * because viem matches tuple components by name and ignores the extra keys once the struct
 * drops them, which keeps a client built against either ABI working.
 */
export interface OnChainVerdict {
  slot: number;
  responseBody: Hex;
  signature: Hex;
  contentOffset?: number;
  finishOffset?: number;
  createdOffset?: number;
}

/**
 * Pack one committee member's raw response into the submittable tuple.
 *
 * A member that failed to answer is packed with an empty body: the contract demands every
 * seat every round, so an absent model becomes a visible on-chain rejection rather than a
 * silent shrinking of the committee.
 */
export function packVerdict(
  slot: number,
  responseBody: Uint8Array | null,
  signature: Hex | null,
  grammar: Grammar = DEFAULT_GRAMMAR,
): OnChainVerdict {
  if (!responseBody || responseBody.length === 0 || !signature) {
    return {
      slot,
      responseBody: '0x',
      signature: signature ?? '0x',
      contentOffset: 0,
      finishOffset: 0,
      createdOffset: 0,
    };
  }
  return {
    slot,
    responseBody: bytesToHex(responseBody),
    signature,
    ...findOffsetsOrZero(responseBody, grammar),
  };
}

export interface CheckVerdictInput {
  slot: number;
  modelId: string;
  schema: PromptSchema;
  evidence: string | Uint8Array;
  responseBody: Uint8Array;
  signature: Hex;
  /** Enclave keys the AttestationRegistry currently accepts for this slot's model. */
  attestedSigners?: readonly Address[];
  minConfidenceBps?: number;
  maxAgeSec?: number;
  futureSkewSec?: number;
  /** Unix seconds to evaluate freshness against. Defaults to now. */
  now?: number;
  grammar?: Grammar;
}

export interface CheckVerdictResult {
  slot: number;
  modelId: string;
  ok: boolean;
  reason: RejectReason;
  detail: string | null;
  /** The check that failed, named the way the contract names it. */
  failedCheck: string | null;
  signer: Address | null;
  requestSha256: string;
  responseSha256: string;
  signedText: string;
  navE6: bigint | null;
  value: string | null;
  confidenceBps: number | null;
  createdAt: number | null;
  ageSec: number | null;
  offsets: VerdictOffsets | null;
}

/**
 * Run every check `_checkVerdict` runs, in the same order, and name the one that failed.
 *
 * Not covered, because it needs chain state: on-chain signer liveness, sequencer uptime,
 * duplicate slots, quorum and the agreement band. {@link checkBundle} does the last two.
 */
export async function checkVerdict(input: CheckVerdictInput): Promise<CheckVerdictResult> {
  const grammar = input.grammar ?? DEFAULT_GRAMMAR;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const futureSkew = input.futureSkewSec ?? 120;
  const request = buildRequestFromSchema(input.schema, input.modelId, input.evidence);

  const result: CheckVerdictResult = {
    slot: input.slot,
    modelId: input.modelId,
    ok: false,
    reason: 'None',
    detail: null,
    failedCheck: null,
    signer: null,
    requestSha256: sha256Hex(request),
    responseSha256: sha256Hex(input.responseBody),
    signedText: '',
    navE6: null,
    value: null,
    confidenceBps: null,
    createdAt: null,
    ageSec: null,
    offsets: null,
  };

  if (input.responseBody.length === 0 || input.responseBody.length > MAX_RESPONSE_BYTES) {
    return {
      ...result,
      reason: 'Malformed',
      failedCheck: 'responseBody length bounds',
      detail:
        input.responseBody.length === 0
          ? 'this committee seat produced no answer'
          : `response body is ${input.responseBody.length} bytes, over the ${MAX_RESPONSE_BYTES} limit`,
    };
  }

  result.signedText = signedText(request, input.responseBody);
  const signer = await recoverEnclaveSigner(request, input.responseBody, input.signature);
  if (!signer) {
    return {
      ...result,
      reason: 'BadSignature',
      failedCheck: 'ecrecover over sha256hex(request):sha256hex(response)',
      detail: 'the signature does not recover over the request the chain rebuilds and the response given',
    };
  }
  result.signer = signer;

  if (input.attestedSigners) {
    const known = input.attestedSigners.some((a) => a.toLowerCase() === signer.toLowerCase());
    if (!known) {
      return {
        ...result,
        reason: 'UnknownSigner',
        failedCheck: 'AttestationRegistry.status(signer, keccak256(modelId))',
        detail: `${signer} is not a live attested enclave for ${input.modelId}`,
      };
    }
  }

  const parsed = parseResponse(input.responseBody, undefined, grammar);
  if (!parsed.ok || !parsed.parsed) {
    return { ...result, reason: parsed.reason, failedCheck: '_parseResponse', detail: parsed.detail };
  }

  result.navE6 = parsed.parsed.navE6;
  result.value = formatE6(parsed.parsed.navE6);
  result.confidenceBps = parsed.parsed.confidenceBps;
  result.createdAt = parsed.parsed.createdAt;
  result.ageSec = now - parsed.parsed.createdAt;
  result.offsets = parsed.parsed.offsets;

  if (input.minConfidenceBps !== undefined && parsed.parsed.confidenceBps < input.minConfidenceBps) {
    return {
      ...result,
      reason: 'LowConfidence',
      failedCheck: 'confBps < cfg.minConfidenceBps',
      detail: `the model reported ${parsed.parsed.confidenceBps} bps of confidence, below the floor of ${input.minConfidenceBps}`,
    };
  }
  if (parsed.parsed.createdAt > now + futureSkew) {
    return {
      ...result,
      reason: 'Stale',
      failedCheck: 'createdAt > block.timestamp + futureSkew',
      detail: `the response claims to be ${parsed.parsed.createdAt - now}s in the future`,
    };
  }
  if (input.maxAgeSec !== undefined && now > parsed.parsed.createdAt + input.maxAgeSec) {
    return {
      ...result,
      reason: 'Stale',
      failedCheck: 'block.timestamp > createdAt + cfg.maxAgeSec',
      detail: `the answer is ${now - parsed.parsed.createdAt}s old and this asset accepts at most ${input.maxAgeSec}s`,
    };
  }

  return { ...result, ok: true, reason: 'None' };
}

// ---------------------------------------------------------------------------------------
// Whole-round check
// ---------------------------------------------------------------------------------------

export interface BundleMember {
  slot: number;
  modelId: string;
  responseBody: Uint8Array;
  signature: Hex;
  attestedSigners?: readonly Address[];
}

export interface BundlePolicy {
  quorum: number;
  minDistinctSigners: number;
  bandBps: number;
  minConfidenceBps: number;
  maxAgeSec: number;
}

export interface BundleResult {
  wouldPublish: boolean;
  /** The halt the contract would record, when it would not publish. */
  haltReason: 'None' | 'InsufficientQuorum' | 'Disagreement' | 'Unauthenticated';
  summary: string;
  members: CheckVerdictResult[];
  accepted: number;
  distinctSigners: number;
  authenticated: number;
  medianE6: bigint | null;
  median: string | null;
  band: { bps: number; lowE6: bigint; highE6: bigint; low: string; high: string } | null;
  outliers: number[];
  observedAt: number | null;
}

/**
 * Re-run an entire round locally: every member, then quorum, distinct signers and the band.
 *
 * Duplicate slots are rejected here the way the contract rejects them, so a bundle that
 * passes this would post cleanly.
 */
export async function checkBundle(
  members: readonly BundleMember[],
  schema: PromptSchema,
  evidence: string | Uint8Array,
  policy: BundlePolicy,
  options: { now?: number; futureSkewSec?: number; grammar?: Grammar } = {},
): Promise<BundleResult> {
  const seen = new Set<number>();
  const results: CheckVerdictResult[] = [];

  for (const member of members) {
    if (seen.has(member.slot)) {
      results.push({
        slot: member.slot,
        modelId: member.modelId,
        ok: false,
        reason: 'DuplicateSlot',
        detail: `slot ${member.slot} was claimed twice in this bundle`,
        failedCheck: 'duplicate slot bitmap',
        signer: null,
        requestSha256: '',
        responseSha256: '',
        signedText: '',
        navE6: null,
        value: null,
        confidenceBps: null,
        createdAt: null,
        ageSec: null,
        offsets: null,
      });
      continue;
    }
    seen.add(member.slot);
    results.push(
      await checkVerdict({
        slot: member.slot,
        modelId: member.modelId,
        schema,
        evidence,
        responseBody: member.responseBody,
        signature: member.signature,
        ...(member.attestedSigners ? { attestedSigners: member.attestedSigners } : {}),
        minConfidenceBps: policy.minConfidenceBps,
        maxAgeSec: policy.maxAgeSec,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.futureSkewSec !== undefined ? { futureSkewSec: options.futureSkewSec } : {}),
        ...(options.grammar ? { grammar: options.grammar } : {}),
      }),
    );
  }

  const passed = results.filter((r) => r.ok);
  const authenticated = results.filter((r) => r.signer !== null && r.reason !== 'BadSignature').length;
  const distinctSigners = new Set(passed.map((r) => r.signer!.toLowerCase())).size;
  const values = passed.map((r) => r.navE6!);
  const observedAt = passed.length ? Math.min(...passed.map((r) => r.createdAt!)) : null;

  const base = {
    members: results,
    accepted: passed.length,
    distinctSigners,
    authenticated,
    observedAt,
  };

  if (authenticated < policy.quorum) {
    return {
      ...base,
      wouldPublish: false,
      haltReason: 'Unauthenticated',
      summary: `only ${authenticated} of ${members.length} answers carried a valid enclave signature; the round would be ignored, not halted`,
      medianE6: null,
      median: null,
      band: null,
      outliers: [],
    };
  }

  if (passed.length < policy.quorum || distinctSigners < policy.minDistinctSigners) {
    return {
      ...base,
      wouldPublish: false,
      haltReason: 'InsufficientQuorum',
      summary: `${passed.length} of ${members.length} answers survived verification against a quorum of ${policy.quorum} and ${policy.minDistinctSigners} distinct enclaves; the oracle would halt`,
      medianE6: null,
      median: null,
      band: null,
      outliers: [],
    };
  }

  const medianE6 = median(values);
  const band = bandAround(medianE6, policy.bandBps);
  const outliers = passed.filter((r) => r.navE6! < band.lowE6 || r.navE6! > band.highE6).map((r) => r.slot);

  if (outliers.length > 0) {
    return {
      ...base,
      wouldPublish: false,
      haltReason: 'Disagreement',
      summary: `slot${outliers.length > 1 ? 's' : ''} ${outliers.join(', ')} fell outside the ${(policy.bandBps / 100).toString()}% band around ${formatE6(medianE6)}; the oracle would halt`,
      medianE6,
      median: formatE6(medianE6),
      band,
      outliers,
    };
  }

  return {
    ...base,
    wouldPublish: true,
    haltReason: 'None',
    summary: `${passed.length} of ${members.length} answers agreed within ${(policy.bandBps / 100).toString()}%; the oracle would publish ${formatE6(medianE6)}`,
    medianE6,
    median: formatE6(medianE6),
    band,
    outliers: [],
  };
}

/** Same median the contract computes: an insertion sort, and the mean of the middle pair. */
export function median(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  if (n === 0) throw new Error('median of an empty set');
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2n;
}

/**
 * The band the contract enforces. Solidity tests `dev * BPS > median * bandBps`, which is
 * an inclusive bound, so the endpoints computed here are themselves acceptable.
 */
export function bandAround(medianE6: bigint, bandBps: number) {
  const spread = (medianE6 * BigInt(bandBps)) / BigInt(BPS);
  const lowE6 = medianE6 > spread ? medianE6 - spread : 0n;
  const highE6 = medianE6 + spread;
  return { bps: bandBps, lowE6, highE6, low: formatE6(lowE6), high: formatE6(highE6) };
}

/** 1e6-scaled integer to a decimal string, without going through a float. */
export function formatE6(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function parseE6(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}
