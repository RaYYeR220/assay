/**
 * canonical.ts — byte-exact request construction, receipt verification, and the
 * TypeScript mirror of the on-chain parser.
 *
 * THE INVARIANT
 * -------------
 * `AssayOracle._checkVerdict` rebuilds the request bytes itself via
 * `assets.buildRequest(assetId, slot, evidence)`, sha256's them, sha256's the response
 * body the poster submits, concatenates
 *
 *     "\x19Ethereum Signed Message:\n129" || sha256hex(req) || ":" || sha256hex(resp)
 *
 * keccak256's it and ecrecovers. The recovered address must be a live attested signer
 * bound to `keccak256(modelAt(assetId, slot))`.
 *
 * So every byte we POST must equal what Solidity concatenates. The template is NOT
 * defined here — it is exported from `script/Schema.sol` into `assay/schema.appraisal.v1.json`
 * and loaded at runtime. If Solidity changes, this file follows automatically.
 *
 *     requestBody = head || utf8(modelId) || mid || evidence || tail
 *
 * GATEWAY GROUND TRUTH (verified in Dstack-TEE/private-ai-gateway @ 30296dd)
 *   - `request_body` is the RAW client bytes, verbatim off the wire. No re-serialisation,
 *     no key reordering, no whitespace normalisation, no injected fields. The gateway's
 *     own normalisation lands in a *different* receipt event (`request.forwarded`); the
 *     signed event is `request.received`.  => we control these bytes completely.
 *   - `response_body` is the exact bytes served to the client, but under the middleware
 *     path those bytes are the gateway's own `serde_json::to_vec` of a filtered value
 *     (`system_fingerprint` stripped, `usage.cost` added). => NOT reconstructible on-chain;
 *     the poster must submit them and the chain hashes what it is given. Which is exactly
 *     what the Verdict struct does.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverMessageAddress, isAddressEqual, type Hex } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The locked schema, loaded from Solidity's own export
// ---------------------------------------------------------------------------

export interface AppraisalSchema {
  head: Hex;
  mid: Hex;
  tail: Hex;
  schemaId: Hex;
}

const SCHEMA_PATH =
  process.env.ASSAY_SCHEMA_PATH ?? join(HERE, '..', '..', 'schema.appraisal.v1.json');

function hexToBuf(h: string): Buffer {
  if (!/^0x[0-9a-fA-F]*$/.test(h)) throw new Error(`not hex: ${h.slice(0, 32)}`);
  return Buffer.from(h.slice(2), 'hex');
}

export const SCHEMA: AppraisalSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as AppraisalSchema;

/** The three constant byte spans, decoded once. */
export const HEAD = hexToBuf(SCHEMA.head);
export const MID = hexToBuf(SCHEMA.mid);
export const TAIL = hexToBuf(SCHEMA.tail);
export const SCHEMA_ID = SCHEMA.schemaId;

/** Human-readable forms, for logs and the /request-template endpoint. */
export const HEAD_TEXT = HEAD.toString('utf8');
export const MID_TEXT = MID.toString('utf8');
export const TAIL_TEXT = TAIL.toString('utf8');

// ---------------------------------------------------------------------------
// Request construction — raw bytes, never an object
// ---------------------------------------------------------------------------

/**
 * Build the exact request bytes. Returns a Buffer, not a string, because these bytes go
 * on the wire untouched — no JSON round-trip is permitted anywhere in the path.
 *
 * Mirrors `AssetRegistry.buildRequest(assetId, slot, evidence)` byte for byte.
 */
export function buildRequestBytes(modelId: string, evidence: string): Buffer {
  assertJsonStringSafe(modelId, 'modelId');
  assertJsonStringSafe(evidence, 'evidence');
  return Buffer.concat([HEAD, Buffer.from(modelId, 'utf8'), MID, Buffer.from(evidence, 'utf8'), TAIL]);
}

/** Convenience string form. Safe because the schema and inputs are pure ASCII. */
export function buildRequestString(modelId: string, evidence: string): string {
  return buildRequestBytes(modelId, evidence).toString('utf8');
}

/** Sanity check that the assembled bytes are still valid JSON with the expected shape. */
export function assertRequestWellFormed(modelId: string, evidence: string): void {
  const o = JSON.parse(buildRequestString(modelId, evidence)) as {
    model: string;
    temperature: number;
    max_tokens: number;
    messages: { role: string; content: string }[];
  };
  if (o.model !== modelId) throw new Error('model did not round-trip');
  if (o.messages?.length !== 2) throw new Error('expected exactly 2 messages');
  if (!o.messages[1]!.content.endsWith(evidence)) throw new Error('evidence did not round-trip');
}

// ---------------------------------------------------------------------------
// Evidence charset — mirrors Ascii.isJsonStringSafe exactly
// ---------------------------------------------------------------------------

/**
 * Solidity: `c < 0x20 || c == 0x22 || c == 0x5c || c > 0x7e` is rejected.
 * So the allowed set is 0x20..0x7E minus `"` (0x22) and `\` (0x5C).
 *
 * Enforced ON-CHAIN at asset registration, so a violating evidence document never reaches
 * a model. We enforce it here too, at build time, so it never reaches the chain either.
 */
export const JSON_SAFE_RE = /^[\x20-\x21\x23-\x5B\x5D-\x7E]*$/;

export function isJsonStringSafe(s: string): boolean {
  return JSON_SAFE_RE.test(s);
}

export function assertJsonStringSafe(s: string, what = 'value'): void {
  if (isJsonStringSafe(s)) return;
  const bad = [...s].find((c) => !JSON_SAFE_RE.test(c));
  const cp = bad ? bad.codePointAt(0)!.toString(16).padStart(2, '0') : '??';
  throw new Error(
    `${what} contains a byte the contract rejects: ${JSON.stringify(bad)} (0x${cp}). ` +
      'Ascii.isJsonStringSafe allows only 0x20-0x7E excluding " and \\.',
  );
}

/** Fold real-world text into the on-chain-legal charset. Lossy on purpose. */
export function sanitiseToSafeCharset(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, "'")
    .replace(/[‐-―−]/g, '-')
    .replace(/[  -​]/g, ' ')
    .replace(/…/g, '...')
    .replace(/\p{M}/gu, '')
    .replace(/"/g, "'")
    .replace(/\\/g, '/')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Hashing + the 129-char signed text
// ---------------------------------------------------------------------------

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/** `sha256hex(req) + ":" + sha256hex(resp)` — exactly 129 ASCII chars. */
export function buildSignedText(requestBody: string | Uint8Array, responseBody: string | Uint8Array): string {
  const text = `${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  if (text.length !== 129) throw new Error(`signed text must be 129 chars, got ${text.length}`);
  return text;
}

/** The exact preimage `AssayOracle` keccak256's. `EIP191_PREFIX_129` in Solidity. */
export const EIP191_PREFIX_129 = '\x19Ethereum Signed Message:\n129';

export function eip191Preimage(text: string): string {
  if (text.length !== 129) throw new Error(`expected 129-char text, got ${text.length}`);
  return EIP191_PREFIX_129 + text;
}

// ---------------------------------------------------------------------------
// Verification — the TypeScript mirror of _checkVerdict's signature half
// ---------------------------------------------------------------------------

export interface Receipt {
  requestBody: string | Uint8Array;
  responseBody: string | Uint8Array;
  signature: Hex;
}

export interface VerifyResult {
  ok: boolean;
  recovered: `0x${string}` | null;
  requestHash: string;
  responseHash: string;
  signedText: string;
  reason?: string;
}

export async function verifyReceipt(r: Receipt, expectedSigner?: string): Promise<VerifyResult> {
  const requestHash = sha256Hex(r.requestBody);
  const responseHash = sha256Hex(r.responseBody);
  const signedText = `${requestHash}:${responseHash}`;

  if (!/^0x[0-9a-fA-F]{130}$/.test(r.signature)) {
    return {
      ok: false, recovered: null, requestHash, responseHash, signedText,
      reason: 'signature must be 65 bytes (0x + 130 hex)',
    };
  }
  let recovered: `0x${string}`;
  try {
    recovered = await recoverMessageAddress({ message: signedText, signature: r.signature });
  } catch (e) {
    return { ok: false, recovered: null, requestHash, responseHash, signedText, reason: `ecrecover failed: ${(e as Error).message}` };
  }
  if (expectedSigner && !isAddressEqual(recovered, expectedSigner as `0x${string}`)) {
    return { ok: false, recovered, requestHash, responseHash, signedText, reason: `recovered ${recovered} != attested ${expectedSigner}` };
  }
  return { ok: true, recovered, requestHash, responseHash, signedText };
}

// ---------------------------------------------------------------------------
// The on-chain response grammar — mirrors AssayOracle's owner-settable patterns
// ---------------------------------------------------------------------------

export const GRAMMAR = {
  contentPrefix: '"content":"ASSAY1|nav_usd_e6=',
  confidenceInfix: '|confidence_bps=',
  contentSuffix: '"',
  finishPattern: '"finish_reason":"stop"',
  createdPattern: '"created":',
} as const;

/** The single line a committee member is allowed to produce. */
export const VERDICT_SHAPE = 'ASSAY1|nav_usd_e6=<integer>|confidence_bps=<integer>';

/**
 * Mirrors `RejectReason` in Types.sol, IN DECLARATION ORDER — the index is what the chain
 * emits, so the order is part of the ABI and must not be rearranged.
 */
export const REJECT_REASONS = [
  'None',
  'BadSignature',
  'UnknownSigner',
  'SignerExpired',
  'SignerRevoked',
  'WrongModel',
  'Truncated',
  'Malformed',
  'OutOfRange',
  'LowConfidence',
  'Stale',
  'DuplicateSlot',
  'NoTimestamp',
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

/** Numeric value the chain emits for a reason. */
export function rejectReasonIndex(r: RejectReason): number {
  return REJECT_REASONS.indexOf(r);
}

export const MAX_NAV_E6 = 1_000_000_000_000_000n; // keep in sync with AssayOracle.MAX_NAV_E6
export const BPS = 10_000;
/** AssayOracle.MAX_RESPONSE — a body outside (0, 8192] never reaches the signature check. */
export const MAX_RESPONSE = 8192;

// ---------------------------------------------------------------------------
// Offset discovery — found by SEARCHING the raw bytes, never hardcoded
// ---------------------------------------------------------------------------

export interface VerdictOffsets {
  contentOffset: number;
  finishOffset: number;
  createdOffset: number;
}

/**
 * Locate the three literals.
 *
 * ⚠️ THESE ARE NO LONGER READ ON CHAIN. After the audit, `AssayOracle` scans for each
 * pattern itself via `Ascii.locate`, and the `Verdict` offset fields are inert — carried
 * only so an indexer can point at the fields without re-scanning. They travelled outside
 * the signed payload, so anyone watching the mempool could copy a pending round, corrupt
 * an offset, land first and halt the oracle for the price of gas.
 *
 * We still compute them honestly, because a wrong value is now merely useless rather than
 * dangerous, and an indexer benefits from a correct one.
 *
 * Note `contentPrefix` opens with an unescaped `"`, which cannot occur inside a JSON
 * string — so a model cannot forge a second copy of it inside its own answer.
 */
export function findVerdictOffsets(responseBody: string | Uint8Array): VerdictOffsets {
  const buf = typeof responseBody === 'string' ? Buffer.from(responseBody, 'utf8') : Buffer.from(responseBody);
  const find = (needle: string, what: string): number => {
    const at = buf.indexOf(Buffer.from(needle, 'utf8'));
    if (at < 0) throw new OffsetNotFoundError(what, needle);
    return at;
  };
  return {
    contentOffset: find(GRAMMAR.contentPrefix, 'contentOffset'),
    finishOffset: find(GRAMMAR.finishPattern, 'finishOffset'),
    createdOffset: find(GRAMMAR.createdPattern, 'createdOffset'),
  };
}

export class OffsetNotFoundError extends Error {
  // Plain fields, not parameter properties — node --experimental-strip-types runs in
  // strip-only mode and cannot desugar `constructor(public x)`.
  readonly what: string;
  readonly needle: string;
  constructor(what: string, needle: string) {
    super(`HALT:${what.toUpperCase()}_NOT_FOUND (no ${JSON.stringify(needle)} in response body)`);
    this.name = 'OffsetNotFoundError';
    this.what = what;
    this.needle = needle;
  }
}

// ---------------------------------------------------------------------------
// The strict parser — a byte-for-byte mirror of AssayOracle._parseResponse
// ---------------------------------------------------------------------------

export interface ParsedVerdict {
  navE6: bigint;
  confBps: number;
  createdAt: number;
  offsets: VerdictOffsets;
  /**
   * Raw bytes of trailing whitespace the contract skipped before the closing quote.
   * Zero means a byte-perfect line. Non-zero is still a PASS — the contract accepts it —
   * but compliance reporting separates the two so we can see which models need the
   * tolerance and which do not.
   */
  trailingWhitespaceBytes: number;
}

export interface ParseOutcome {
  ok: boolean;
  reason: RejectReason;
  parsed: ParsedVerdict | null;
  /** Human detail for logs. The chain only emits `reason`. */
  detail?: string;
}

function toBuf(x: string | Uint8Array): Buffer {
  return typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x);
}

function matchAt(buf: Buffer, offset: number, pattern: string): boolean {
  const p = Buffer.from(pattern, 'utf8');
  if (offset < 0 || offset + p.length > buf.length) return false;
  return buf.compare(p, 0, p.length, offset, offset + p.length) === 0;
}

/**
 * Cap on how many trailing whitespace items may be skipped after the confidence digits.
 * Keep in sync with the `8` passed to `Ascii.skipJsonWhitespace` in `AssayOracle._parseResponse`.
 */
export const MAX_TRAILING_WS_RUN = 8;

/**
 * Mirrors `Ascii.skipJsonWhitespace`.
 *
 * Accepts a literal space (0x20) or the two-byte JSON escapes `\n`, `\r`, `\t` — and nothing
 * else. Each counts as ONE step against `maxRun`, so a two-byte escape costs the same as a
 * space. Letters, punctuation and any other escape terminate the run, so this cannot widen
 * into tolerance for prose: a trailing period or word still rejects.
 *
 * Models routinely end a line with a newline. Refusing an answer over that would be pedantry
 * rather than strictness.
 */
export function skipJsonWhitespace(buf: Buffer, offset: number, maxRun = MAX_TRAILING_WS_RUN): number {
  let next = offset;
  let steps = 0;
  while (next < buf.length && steps < maxRun) {
    const c = buf[next]!;
    if (c === 0x20) { next += 1; steps += 1; continue; }
    if (c === 0x5c && next + 1 < buf.length) {
      const d = buf[next + 1]!;
      if (d === 0x6e || d === 0x72 || d === 0x74) { next += 2; steps += 1; continue; }
    }
    break;
  }
  return next;
}

/** Mirrors `Ascii.readUint`: a run of ASCII digits, max 30, no sign, no decimal. */
function readUint(buf: Buffer, offset: number): { value: bigint; next: number; ok: boolean } {
  let i = offset;
  let value = 0n;
  let digits = 0;
  while (i < buf.length) {
    const c = buf[i]!;
    if (c < 0x30 || c > 0x39) break;
    value = value * 10n + BigInt(c - 0x30);
    i++; digits++;
    if (digits > 30) return { value: 0n, next: offset, ok: false };
  }
  if (digits === 0) return { value: 0n, next: offset, ok: false };
  return { value, next: i, ok: true };
}

/**
 * Mirrors `AssayOracle._readCreated`: scan for `"created":` and read the uint after it.
 * Returns `ok: false` for `RejectReason.NoTimestamp`.
 */
export function readCreated(responseBody: string | Uint8Array): { createdAt: number; ok: boolean } {
  const buf = toBuf(responseBody);
  const at = buf.indexOf(Buffer.from(GRAMMAR.createdPattern, 'utf8'));
  if (at < 0) return { createdAt: 0, ok: false };
  const r = readUint(buf, at + GRAMMAR.createdPattern.length);
  if (!r.ok || r.value > 0xffffffffffffffffn) return { createdAt: 0, ok: false };
  return { createdAt: Number(r.value), ok: true };
}

/**
 * Mirrors `AssayOracle._readAnswer`: the strict grammar check, with NO timestamp handling.
 * Freshness is established before this runs — see `preflightVerdict`.
 */
export function readAnswer(responseBody: string | Uint8Array): ParseOutcome {
  const buf = toBuf(responseBody);

  if (buf.indexOf(Buffer.from(GRAMMAR.finishPattern, 'utf8')) < 0) {
    return { ok: false, reason: 'Truncated', parsed: null, detail: 'finish_reason != stop (model hit the token cap or errored)' };
  }
  const contentAt = buf.indexOf(Buffer.from(GRAMMAR.contentPrefix, 'utf8'));
  if (contentAt < 0) {
    return { ok: false, reason: 'Malformed', parsed: null, detail: 'response does not contain the exact ASSAY1 line' };
  }

  let p = contentAt + GRAMMAR.contentPrefix.length;
  const nav = readUint(buf, p);
  if (!nav.ok) return { ok: false, reason: 'Malformed', parsed: null, detail: 'nav_usd_e6 is not an integer' };
  p = nav.next;

  if (!matchAt(buf, p, GRAMMAR.confidenceInfix)) {
    return { ok: false, reason: 'Malformed', parsed: null, detail: 'missing |confidence_bps= directly after nav' };
  }
  p += GRAMMAR.confidenceInfix.length;

  const conf = readUint(buf, p);
  if (!conf.ok) return { ok: false, reason: 'Malformed', parsed: null, detail: 'confidence_bps is not an integer' };
  p = conf.next;

  // Past trailing whitespace, the closing quote must come immediately. Anything else is
  // commentary, and commentary is what this oracle refuses to price on.
  const afterDigits = p;
  p = skipJsonWhitespace(buf, p);
  if (!matchAt(buf, p, GRAMMAR.contentSuffix)) {
    return {
      ok: false,
      reason: 'Malformed',
      parsed: null,
      detail: p > afterDigits
        ? 'trailing content after confidence_bps and its whitespace (prose/markdown)'
        : 'trailing content after confidence_bps (prose/markdown)',
    };
  }
  const trailingWhitespaceBytes = p - afterDigits;

  if (nav.value === 0n || nav.value > MAX_NAV_E6 || conf.value > BigInt(BPS)) {
    return { ok: false, reason: 'OutOfRange', parsed: null, detail: `nav=${nav.value} conf=${conf.value}` };
  }

  const created = readCreated(buf);
  let offsets: VerdictOffsets = { contentOffset: 0, finishOffset: 0, createdOffset: 0 };
  try { offsets = findVerdictOffsets(buf); } catch { /* advisory only */ }

  return {
    ok: true,
    reason: 'None',
    parsed: {
      navE6: nav.value,
      confBps: Number(conf.value),
      createdAt: created.createdAt,
      offsets,
      trailingWhitespaceBytes,
    },
  };
}

/**
 * Convenience: the full read, timestamp included, in the contract's order.
 *
 * Prefer `preflightVerdict` for anything that will be posted — this skips the signature,
 * attestation and watermark checks that sit between the timestamp and the answer on chain.
 */
export function parseResponseOnChain(responseBody: string | Uint8Array): ParseOutcome {
  const buf = toBuf(responseBody);
  if (buf.length === 0) {
    return { ok: false, reason: 'BadSignature', parsed: null, detail: 'empty responseBody — never reaches the parser on chain' };
  }
  if (buf.length > MAX_RESPONSE) {
    return { ok: false, reason: 'BadSignature', parsed: null, detail: `responseBody ${buf.length} > MAX_RESPONSE ${MAX_RESPONSE}` };
  }
  if (!readCreated(buf).ok) {
    return { ok: false, reason: 'NoTimestamp', parsed: null, detail: 'no readable "created": timestamp' };
  }
  return readAnswer(buf);
}

// ---------------------------------------------------------------------------
// The submittable Verdict tuple
// ---------------------------------------------------------------------------

/**
 * Exactly the `Verdict` struct in Types.sol — THREE fields.
 *
 * The offset hints were deleted by the audit. They travelled outside the signed payload, so
 * anyone watching the mempool could copy a pending round, corrupt an offset, land first and
 * halt the oracle for the price of gas. The contract now scans for each pattern itself with
 * `Ascii.locate`, and there is nothing left to corrupt.
 *
 * `test/canonical.test.ts` asserts these keys against the COMPILED ABI in `out/`, so a
 * struct change breaks the test rather than silently producing an unencodable call.
 */
export interface OnChainVerdict {
  slot: number;
  responseBody: Hex;
  signature: Hex;
}

/**
 * Pack one committee member's raw response into the tuple the contract takes.
 *
 * An UNAVAILABLE member is packed with an empty `responseBody` — the contract requires ALL
 * slots every round and rejects the empty one as `RejectReason.BadSignature` (deliberately
 * NOT Malformed: nothing was authenticated, so counting it on the authenticated side would
 * hand anyone a free halt for the cost of assembling empty bodies). A missing model is a
 * recorded rejection, never a silent omission that quietly shrinks the committee.
 */
export function packVerdict(
  slot: number,
  responseBody: string | Uint8Array | null,
  signature: Hex | null,
): OnChainVerdict {
  if (responseBody === null || signature === null || (typeof responseBody === 'string' && responseBody.length === 0)) {
    return { slot, responseBody: '0x', signature: signature ?? '0x' };
  }
  const buf = toBuf(responseBody);
  return { slot, responseBody: `0x${buf.toString('hex')}`, signature };
}

// ---------------------------------------------------------------------------
// Pre-flight: reproduce the ENTIRE on-chain check before spending gas
// ---------------------------------------------------------------------------

export interface PreflightInput {
  slot: number;
  modelId: string;
  evidence: string;
  responseBody: string | Uint8Array;
  signature: Hex;
  /** The attested signer for this model, from /v1/attestation/report. */
  attestedSigner?: string;
  minConfidenceBps?: number;
  maxAgeSec?: number;
  /** Unix seconds to evaluate staleness against. Defaults to now. */
  now?: number;
  futureSkewSec?: number;
  /** `observationWatermark[assetId]` — a verdict at or before this is Stale. */
  observationWatermark?: number;
  /**
   * Whether the issuer has committed `sha256(evidence)` via `AssetRegistry.commitEvidence`.
   * `false` makes the whole round revert with `EvidenceNotCommitted`; `undefined` means we
   * could not check (no RPC configured) and is reported as unknown, never as fine.
   */
  evidenceCommitted?: boolean;
}

export interface PreflightResult {
  slot: number;
  modelId: string;
  ok: boolean;
  /** The check that failed, named as the contract names it. */
  failedCheck: string | null;
  reason: RejectReason;
  detail: string | null;
  requestBody: string;
  requestSha256: string;
  responseSha256: string;
  signedText: string;
  recovered: string | null;
  navE6: string | null;
  confBps: number | null;
  createdAt: number | null;
  ageSec: number | null;
  offsets: VerdictOffsets | null;
  /**
   * Round-level blocker, kept separate from the per-verdict reason: this aborts the whole
   * `postAppraisal` call before any verdict is examined, so it is not a rejection of THIS
   * slot and must not be reported as one.
   */
  roundBlocker: string | null;
}

/**
 * Run every check `AssayOracle._checkVerdict` runs, IN THE SAME ORDER, and name the one
 * that failed.
 *
 * The ordering is load-bearing, not cosmetic. Freshness is established BEFORE the answer is
 * read, because a rejection that counts toward `authed` is what lets a round halt the
 * oracle: if a badly-formed answer could be counted without first proving it is recent, one
 * authentic but unparseable response would become a bearer token that halts the asset
 * forever. Reporting these checks out of order would hide that.
 *
 * Order: body bounds -> signature -> attestation -> timestamp readable -> future skew
 *        -> max age -> watermark -> answer grammar -> confidence floor.
 *
 * Not fully checkable off chain (needs chain state): signer liveness, revocation and expiry
 * in AttestationRegistry, sequencer uptime, duplicate slots, quorum and band.
 */
export async function preflightVerdict(i: PreflightInput): Promise<PreflightResult> {
  const now = i.now ?? Math.floor(Date.now() / 1000);
  const futureSkew = i.futureSkewSec ?? 120;
  const requestBody = buildRequestString(i.modelId, i.evidence);
  const respBuf = toBuf(i.responseBody);

  const base: PreflightResult = {
    slot: i.slot,
    modelId: i.modelId,
    ok: false,
    failedCheck: null,
    reason: 'None',
    detail: null,
    requestBody,
    requestSha256: sha256Hex(requestBody),
    responseSha256: sha256Hex(respBuf),
    signedText: '',
    recovered: null,
    navE6: null,
    confBps: null,
    createdAt: null,
    ageSec: null,
    offsets: null,
    roundBlocker:
      i.evidenceCommitted === false
        ? `EvidenceNotCommitted(sha256=${sha256Hex(i.evidence)}) — the issuer must call ` +
          'AssetRegistry.commitEvidence(assetId, evidenceHash, uri, true) before this round can post'
        : null,
  };

  // 1. Body bounds. Empty or oversize is BadSignature, NOT Malformed: nothing here was
  //    authenticated, so it must not land on the authenticated side of the round.
  if (respBuf.length === 0) {
    return { ...base, failedCheck: 'responseBody.length == 0', reason: 'BadSignature', detail: 'model produced nothing' };
  }
  if (respBuf.length > MAX_RESPONSE) {
    return { ...base, failedCheck: 'responseBody.length > MAX_RESPONSE', reason: 'BadSignature', detail: `${respBuf.length} > ${MAX_RESPONSE}` };
  }

  // 2. Signature over the rebuilt request.
  const v = await verifyReceipt({ requestBody, responseBody: respBuf, signature: i.signature }, i.attestedSigner);
  base.signedText = v.signedText;
  base.recovered = v.recovered;
  if (!v.ok) {
    // 3. A signature that recovers to an unexpected address is what the chain reports as
    //    UnknownSigner or WrongModel (it can tell them apart from registry state; we
    //    cannot). One that will not recover at all is BadSignature.
    const recovered = v.recovered !== null;
    return {
      ...base,
      failedCheck: recovered
        ? 'attestations.status(signer, modelIdHash)'
        : 'ecrecover(EIP191(sha256hex(req):sha256hex(resp)))',
      reason: recovered ? 'UnknownSigner' : 'BadSignature',
      detail: recovered
        ? `${v.reason ?? 'signer not attested'} — on chain this is UnknownSigner if the key is unknown, WrongModel if it is attested for a different model`
        : v.reason ?? null,
    };
  }

  // 4. The timestamp must be READABLE before anything else about the body is judged.
  const created = readCreated(respBuf);
  if (!created.ok) {
    return { ...base, failedCheck: '_readCreated', reason: 'NoTimestamp', detail: 'no readable "created": timestamp in the response body' };
  }
  base.createdAt = created.createdAt;
  base.ageSec = now - created.createdAt;

  // 5. Future skew.
  if (created.createdAt > now + futureSkew) {
    return { ...base, failedCheck: 'createdAt > block.timestamp + futureSkew', reason: 'Stale', detail: `created ${created.createdAt} is ${created.createdAt - now}s in the future` };
  }
  // 6. Max age.
  if (i.maxAgeSec !== undefined && now > created.createdAt + i.maxAgeSec) {
    return { ...base, failedCheck: 'block.timestamp > createdAt + cfg.maxAgeSec', reason: 'Stale', detail: `age ${now - created.createdAt}s > ${i.maxAgeSec}s` };
  }
  // 7. Monotonic watermark — a verdict no newer than the last accepted round is stale.
  if (i.observationWatermark !== undefined && created.createdAt <= i.observationWatermark) {
    return { ...base, failedCheck: 'createdAt <= observationWatermark[assetId]', reason: 'Stale', detail: `created ${created.createdAt} <= watermark ${i.observationWatermark}` };
  }

  // 8. The answer itself.
  const p = readAnswer(respBuf);
  if (!p.ok) {
    return { ...base, failedCheck: '_readAnswer', reason: p.reason, detail: p.detail ?? null };
  }
  const parsed = p.parsed!;
  base.navE6 = parsed.navE6.toString();
  base.confBps = parsed.confBps;
  base.offsets = parsed.offsets;

  // 9. Confidence floor.
  if (i.minConfidenceBps !== undefined && parsed.confBps < i.minConfidenceBps) {
    return { ...base, failedCheck: 'confBps < cfg.minConfidenceBps', reason: 'LowConfidence', detail: `${parsed.confBps} < ${i.minConfidenceBps}` };
  }

  return { ...base, ok: base.roundBlocker === null, reason: 'None' };
}
