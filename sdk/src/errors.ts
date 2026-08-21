import { decodeErrorResult, type Abi, type Hex } from 'viem';
import { assayOracleAbi, assayVaultAbi, assetRegistryAbi, attestationRegistryAbi } from './abi/index.ts';
import { HALT_REASON_TEXT, haltReasonName, type HaltReason } from './enums.ts';
import type { Refusal, RefusalReason } from './types.ts';

/** Every custom error the protocol can raise, in one ABI so a selector always resolves. */
export const ASSAY_ERROR_ABI: Abi = [
  ...assayOracleAbi,
  ...assetRegistryAbi,
  ...attestationRegistryAbi,
  ...assayVaultAbi,
].filter((item) => item.type === 'error') as Abi;

const SOLIDITY_ERROR_SELECTOR = '0x08c379a0';
const SOLIDITY_PANIC_SELECTOR = '0x4e487b71';

/** Thrown by the reads that are supposed to refuse, carrying the decoded reason. */
export class AssayRefusalError extends Error {
  readonly refusal: Refusal;
  readonly cause: unknown;

  constructor(refusal: Refusal, cause?: unknown) {
    super(refusal.detail);
    this.name = 'AssayRefusalError';
    this.refusal = refusal;
    this.cause = cause;
  }
}

/** Extra facts that let the explanation name real numbers instead of "the configured band". */
export interface ExplainContext {
  bandBps?: number;
  disputeBandBps?: number;
  maxAgeSec?: number;
  /** Unix seconds, for age arithmetic. Defaults to now. */
  now?: number;
  assetId?: Hex;
}

/**
 * Turn a caught revert into something a human or an agent can act on.
 *
 * This is the function most integrations will actually use. A revert from this protocol is
 * usually not a bug: it is the oracle declining to price something, and the reason is the
 * information. Callers should branch on `reason` and print `detail`.
 */
export function explainRevert(error: unknown, ctx: ExplainContext = {}): Refusal {
  const data = extractRevertData(error);

  if (data) {
    const explained = explainRevertData(data, ctx);
    if (explained) return explained;
  }

  const decoded = extractDecodedError(error);
  if (decoded) {
    const built = fromNamedError(decoded.errorName, decoded.args ?? [], ctx);
    if (built) return built;
  }

  return fromOpaqueError(error, data);
}

/** Same decoding, when you already hold the raw revert bytes. */
export function explainRevertData(data: Hex, ctx: ExplainContext = {}): Refusal | undefined {
  const selector = data.slice(0, 10).toLowerCase() as Hex;

  if (selector === SOLIDITY_ERROR_SELECTOR || selector === SOLIDITY_PANIC_SELECTOR) {
    try {
      const { errorName, args } = decodeErrorResult({ abi: ASSAY_ERROR_ABI, data });
      const text = args?.[0];
      return {
        reason: 'reverted',
        detail:
          errorName === 'Panic'
            ? `the call hit a Solidity panic (code ${String(text)})`
            : `the call reverted: ${String(text)}`,
        error: errorName,
        isRefusalToPrice: false,
        selector,
        data,
      };
    } catch {
      /* fall through to the opaque form */
    }
  }

  try {
    const { errorName, args } = decodeErrorResult({ abi: ASSAY_ERROR_ABI, data });
    const built = fromNamedError(errorName, (args ?? []) as readonly unknown[], ctx);
    if (built) return { ...built, selector, data };
  } catch {
    return {
      reason: 'unknown',
      detail: `the call reverted with data no Assay contract declares (${selector})`,
      isRefusalToPrice: false,
      selector,
      data,
    };
  }
  return undefined;
}

function fromNamedError(
  errorName: string,
  args: readonly unknown[],
  ctx: ExplainContext,
): Refusal | undefined {
  const now = ctx.now ?? Math.floor(Date.now() / 1000);
  const arg = (i: number): string => stringify(args[i]);

  switch (errorName) {
    // ---- the oracle refusing to price -------------------------------------------------
    case 'OracleHalted': {
      const halt = haltReasonName(Number(args[1] ?? 0));
      return {
        reason: 'halted',
        detail: haltDetail(halt, ctx),
        error: errorName,
        args: { assetId: arg(0), haltReason: halt },
        isRefusalToPrice: true,
      };
    }
    case 'NavStale': {
      const observedAt = Number(args[1] ?? 0);
      const age = now - observedAt;
      const window = ctx.maxAgeSec ? ` and the freshness window is ${duration(ctx.maxAgeSec)}` : '';
      return {
        reason: 'stale',
        detail: `the last attested price was observed ${duration(age)} ago${window}, so it is no longer usable`,
        error: errorName,
        args: { assetId: arg(0), observedAt: String(observedAt), ageSec: String(age) },
        isRefusalToPrice: true,
      };
    }
    case 'NavDisputed':
      return {
        reason: 'disputed',
        detail:
          'a challenge is open against the current price, so consumers are frozen until it is resolved',
        error: errorName,
        args: { assetId: arg(0) },
        isRefusalToPrice: true,
      };
    case 'NoNav':
      return {
        reason: 'no-nav',
        detail: 'no round has ever published a price for this asset',
        error: errorName,
        args: { assetId: arg(0) },
        isRefusalToPrice: true,
      };
    case 'SequencerDown':
      return {
        reason: 'sequencer-down',
        detail: 'the L2 sequencer uptime feed is unhealthy, so no price is trusted right now',
        error: errorName,
        isRefusalToPrice: true,
      };
    case 'AssetNotActive':
      return {
        reason: 'asset-inactive',
        detail: 'the issuer has delisted this asset, so it cannot be appraised or priced',
        error: errorName,
        isRefusalToPrice: true,
      };

    // ---- a round that will not be accepted ---------------------------------------------
    case 'CommitteeIncomplete':
      return {
        reason: 'committee-incomplete',
        detail: `the round carried ${arg(0)} verdicts but the committee has ${arg(1)} seats; every seat must be submitted, including the ones that failed to answer`,
        error: errorName,
        args: { given: arg(0), expected: arg(1) },
        isRefusalToPrice: false,
      };
    case 'UnauthenticatedRound':
      return {
        reason: 'unauthenticated',
        detail: `only ${arg(0)} verdicts carried a valid enclave signature, too few for the round to mean anything; it was ignored rather than recorded as a halt`,
        error: errorName,
        args: { authenticated: arg(0) },
        isRefusalToPrice: true,
      };
    case 'InconclusiveRound': {
      const halt = haltReasonName(Number(args[0] ?? 0));
      return {
        reason: 'halted',
        detail: `the re-appraisal could not conclude: ${haltDetail(halt, ctx)}`,
        error: errorName,
        args: { haltReason: halt },
        isRefusalToPrice: true,
      };
    }
    case 'EvidenceNotCommitted':
      return {
        reason: 'evidence-rejected',
        detail:
          `the issuer has not committed to this evidence document, so the oracle will not price it. ` +
          `Have the issuer call AssetRegistry.commitEvidence(assetId, ${arg(0)}, uri, true) first. ` +
          `The digest is sha256 of the exact evidence bytes, so a single changed character produces a different one.`,
        error: errorName,
        args: { evidenceHash: arg(0) },
        isRefusalToPrice: false,
      };
    case 'EvidenceTooLong':
      return {
        reason: 'evidence-rejected',
        detail: 'the evidence document exceeds the 8192-byte limit the contract accepts',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'EvidenceNotJsonSafe':
      return {
        reason: 'evidence-rejected',
        detail:
          'the evidence contains a byte the contract rejects; only printable ASCII 0x20-0x7E is allowed, excluding the quote and backslash characters that would restructure the prompt',
        error: errorName,
        isRefusalToPrice: false,
      };

    // ---- disputes ----------------------------------------------------------------------
    case 'DisputeAlreadyOpen':
      return {
        reason: 'dispute-state',
        detail: 'a challenge is already open for this asset',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'NoOpenDispute':
      return {
        reason: 'dispute-state',
        detail: 'there is no open challenge to resolve for this asset',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'DisputeStillOpen':
      return {
        reason: 'dispute-state',
        detail: `the open challenge cannot be settled until ${isoOrRaw(args[0])}`,
        error: errorName,
        args: { until: arg(0) },
        isRefusalToPrice: false,
      };
    case 'NothingToChallenge':
      return {
        reason: 'dispute-state',
        detail: 'there is no live price to challenge; the asset is already halted, disputed or empty',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'BondTooSmall':
      return {
        reason: 'bond',
        detail: `the challenge bond sent was ${arg(0)} wei but this asset requires ${arg(1)} wei`,
        error: errorName,
        args: { sent: arg(0), required: arg(1) },
        isRefusalToPrice: false,
      };
    case 'BondTransferFailed':
      return {
        reason: 'bond',
        detail: 'the bond could not be paid out; the recipient rejected the transfer',
        error: errorName,
        isRefusalToPrice: false,
      };

    // ---- registries --------------------------------------------------------------------
    case 'NotOwner':
      return {
        reason: 'not-authorised',
        detail: 'only the contract owner can do that',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'NotIssuer':
      return {
        reason: 'not-authorised',
        detail: 'only the issuer that listed this asset can do that',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'UnknownAsset':
      return {
        reason: 'unknown-asset',
        detail: 'no asset is listed under that id',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'AssetExists':
      return {
        reason: 'bad-config',
        detail: 'an asset is already listed under that id',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'UnknownSchema':
      return {
        reason: 'unknown-schema',
        detail: 'the prompt schema this asset points at has not been registered',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'SchemaExists':
      return {
        reason: 'unknown-schema',
        detail: 'that schema id is already registered; schemas are immutable once written',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'BadConfig':
      return {
        reason: 'bad-config',
        detail:
          'the policy is not internally consistent: quorum must be between 1 and the committee size, minDistinctSigners at most quorum, both bands between 1 and 5000 bps, and maxAgeSec non-zero',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'EmptyCommittee':
      return {
        reason: 'bad-config',
        detail: 'a committee must have between 1 and 16 seats',
        error: errorName,
        isRefusalToPrice: false,
      };

    // ---- attestation -------------------------------------------------------------------
    case 'QuoteRejected':
      return {
        reason: 'attestation-rejected',
        detail: 'the TDX quote did not verify against the pinned Intel root of trust',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'ImageNotAllowed':
      return {
        reason: 'attestation-rejected',
        detail: `the quote is valid but its measurement ${arg(0)} is not an approved enclave image`,
        error: errorName,
        args: { measurement: arg(0) },
        isRefusalToPrice: false,
      };
    case 'TcbNotAllowed':
      return {
        reason: 'attestation-rejected',
        detail: `the platform reported Intel TCB status ${arg(0)}, which this registry does not accept`,
        error: errorName,
        args: { tcbStatus: arg(0) },
        isRefusalToPrice: false,
      };
    case 'SignerIsRevoked':
      return {
        reason: 'attestation-rejected',
        detail: `enclave key ${arg(0)} was revoked and cannot be re-registered`,
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'ReportDataTooShort':
      return {
        reason: 'attestation-rejected',
        detail: 'the verified report data is too short to contain a signer address at the configured offset',
        error: errorName,
        isRefusalToPrice: false,
      };

    // ---- vault -------------------------------------------------------------------------
    case 'SubscriptionsClosed':
      return {
        reason: 'vault-limit',
        detail: 'the issuer has paused new subscriptions; redemptions remain open',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'CapExceeded':
      return {
        reason: 'vault-limit',
        detail: `that subscription would take supply to ${arg(0)} shares, past the cap of ${arg(1)}`,
        error: errorName,
        args: { wouldBe: arg(0), cap: arg(1) },
        isRefusalToPrice: false,
      };
    case 'InsufficientLiquidity':
      return {
        reason: 'vault-limit',
        detail: `the redemption needs ${arg(0)} of the settlement currency but the vault holds ${arg(1)}`,
        error: errorName,
        args: { needed: arg(0), available: arg(1) },
        isRefusalToPrice: false,
      };
    case 'ZeroAmount':
      return {
        reason: 'vault-limit',
        detail: 'the amount rounds to zero shares or zero currency at the current price',
        error: errorName,
        isRefusalToPrice: false,
      };

    // ---- ERC-20 ------------------------------------------------------------------------
    case 'ERC20InsufficientBalance':
      return {
        reason: 'token',
        detail: `${arg(0)} holds ${arg(1)} but ${arg(2)} is needed`,
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'ERC20InsufficientAllowance':
      return {
        reason: 'token',
        detail: `the vault is approved for ${arg(1)} but needs ${arg(2)}; raise the allowance first`,
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'ReentrancyGuardReentrantCall':
      return {
        reason: 'vault-limit',
        detail: 'the settlement token re-entered the vault mid-call and the guard stopped it',
        error: errorName,
        isRefusalToPrice: false,
      };
    case 'SafeERC20FailedOperation':
      return {
        reason: 'token',
        detail: `the settlement token at ${arg(0)} rejected the transfer`,
        error: errorName,
        isRefusalToPrice: false,
      };

    default:
      return undefined;
  }
}

function haltDetail(halt: HaltReason | 'Unknown', ctx: ExplainContext): string {
  if (halt === 'Disagreement' && ctx.bandBps) {
    return `the committee disagreed beyond the ${formatBps(ctx.bandBps)} band, so no price was published`;
  }
  if (halt === 'InsufficientQuorum') {
    return 'too few committee answers survived verification to reach quorum, so no price was published';
  }
  if (halt === 'Unknown') {
    return 'the oracle is halted for a reason this SDK build does not know about; regenerate the ABIs';
  }
  return `${HALT_REASON_TEXT[halt]}, so no price is published`;
}

/** Errors that never made it to a revert: transport failures, aborts, plain JavaScript bugs. */
function fromOpaqueError(error: unknown, data?: Hex): Refusal {
  const name = errorName(error);
  const message = errorMessage(error);

  if (/HttpRequest|Timeout|SocketClosed|fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(`${name} ${message}`)) {
    return {
      reason: 'network',
      detail: `could not reach the chain: ${firstLine(message)}`,
      isRefusalToPrice: false,
    };
  }

  const refusal: Refusal = {
    reason: data ? 'reverted' : 'unknown',
    detail: data
      ? `the call reverted with undecodable data ${data.slice(0, 10)}`
      : `the call failed: ${firstLine(message) || 'no message'}`,
    isRefusalToPrice: false,
  };
  if (data) {
    refusal.selector = data.slice(0, 10) as Hex;
    refusal.data = data;
  }
  return refusal;
}

/**
 * Dig the revert payload out of whatever the transport wrapped it in.
 *
 * viem, ethers and bare JSON-RPC all nest the bytes differently, and some nodes only put
 * them in a message string, so this walks the whole object graph rather than trusting one
 * shape.
 */
export function extractRevertData(error: unknown, depth = 0): Hex | undefined {
  if (depth > 12 || error == null) return undefined;

  if (typeof error === 'string') return hexPayload(error);

  if (typeof error !== 'object') return undefined;

  const record = error as Record<string, unknown>;

  for (const key of ['raw', 'data', 'value', 'returnData', 'output', 'revertData'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const hex = hexPayload(candidate);
      if (hex) return hex;
    }
  }

  for (const key of ['data', 'error', 'cause', 'originalError', 'info', 'body', 'shortMessage', 'details', 'metaMessages', 'message'] as const) {
    const child = record[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = extractRevertData(item, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = extractRevertData(child, depth + 1);
    if (found) return found;
  }

  return undefined;
}

/** viem may have decoded the error already; use that when the raw bytes are gone. */
function extractDecodedError(
  error: unknown,
  depth = 0,
): { errorName: string; args?: readonly unknown[] } | undefined {
  if (depth > 12 || error == null || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const data = record['data'];
  if (data && typeof data === 'object') {
    const inner = data as Record<string, unknown>;
    if (typeof inner['errorName'] === 'string') {
      return {
        errorName: inner['errorName'],
        args: Array.isArray(inner['args']) ? (inner['args'] as readonly unknown[]) : undefined,
      };
    }
  }
  for (const key of ['cause', 'error', 'info'] as const) {
    const found = extractDecodedError(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Some nodes only surface the payload inside prose, e.g. `execution reverted: 0xabc...`.
 * The marker is required: an error message routinely contains a contract address, and
 * mistaking one for revert data produces a confident, wrong explanation.
 */
const PROSE_REVERT_DATA = /(?:revert(?:ed)?(?:\s+with)?(?:\s+(?:reason|data|custom\s+error))?[:\s]+|(?:^|\s)data[:=]\s*|returned\s+)(0x[0-9a-fA-F]{8,})/i;

function hexPayload(value: string): Hex | undefined {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]*$/.test(trimmed) && trimmed.length >= 10 && trimmed.length !== 42) {
    return trimmed as Hex;
  }
  const match = trimmed.match(PROSE_REVERT_DATA);
  const captured = match?.[1];
  if (captured && captured.length % 2 === 0 && captured.length !== 42) return captured as Hex;
  return undefined;
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    for (const key of ['shortMessage', 'message', 'details'] as const) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  return String(error);
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || value === null) return '';
  return String(value);
}

function isoOrRaw(value: unknown): string {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return stringify(value);
  return new Date(seconds * 1000).toISOString();
}

/** 1000 bps -> "10%". Trailing zeros dropped so the common cases read as whole numbers. */
export function formatBps(bps: number): string {
  const percent = bps / 100;
  return `${Number(percent.toFixed(2))}%`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export type { RefusalReason };
