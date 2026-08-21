import {
  decodeErrorResult,
  getAddress,
  hexToString,
  keccak256,
  toHex,
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  assayOracleAbi,
  assayVaultAbi,
  assetRegistryAbi,
  attestationRegistryAbi,
  quoteAdapterAbi,
  erc20Abi,
} from '@/abi';
import { haltReasonAt, navStateAt, type HaltReason, type NavState } from './enums';
import { publicClientFor } from './rpc';
import type { Deployment } from './deployments';
import { tcbLabel, type AttestationSnapshot, type AttestedSigner } from './attestation';

/** Every custom error the dashboard may have to name, merged so reverts decode wherever they came from. */
const ERROR_ABI = [...assayOracleAbi, ...assayVaultAbi, ...assetRegistryAbi] as unknown as Abi;

// ---------------------------------------------------------------------------------------
// Revert reporting
// ---------------------------------------------------------------------------------------

export interface RevertInfo {
  /** Solidity error name, e.g. `OracleHalted`. */
  name: string;
  args: readonly unknown[];
  /** The signature as a reader would see it on an explorer. */
  signature: string;
}

/**
 * Pulls the actual custom error out of a failed call.
 *
 * This matters more here than in most applications: the whole point of the vault is that it
 * reverts, so the revert is content, not an error to swallow. A reader gets the real
 * `OracleHalted(assetId, Disagreement)` rather than "transaction failed".
 */
export function describeRevert(error: unknown): RevertInfo | null {
  if (!(error instanceof BaseError)) return null;

  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
    const args = (reverted.data.args ?? []) as readonly unknown[];
    return {
      name: reverted.data.errorName,
      args,
      signature: `${reverted.data.errorName}(${args.map(formatErrorArg).join(', ')})`,
    };
  }

  // The vault's ABI does not carry the oracle's errors, so raw data has to be decoded against
  // the merged set before it can be named.
  const raw = (error as unknown as { walk: (fn: (e: unknown) => boolean) => unknown }).walk(
    (e) => typeof (e as { data?: unknown })?.data === 'string',
  ) as { data?: Hex } | undefined;

  if (raw?.data && raw.data.length >= 10) {
    try {
      const decoded = decodeErrorResult({ abi: ERROR_ABI, data: raw.data });
      const args = (decoded.args ?? []) as readonly unknown[];
      return {
        name: decoded.errorName,
        args,
        signature: `${decoded.errorName}(${args.map(formatErrorArg).join(', ')})`,
      };
    } catch {
      /* not one of ours */
    }
  }
  return null;
}

function formatErrorArg(a: unknown): string {
  if (typeof a === 'bigint') return a.toString();
  if (typeof a === 'string') return a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
  return String(a);
}

/** Names the halt behind a revert, so the vault can explain itself in the oracle's own words. */
export function haltFromRevert(info: RevertInfo | null): HaltReason | null {
  if (!info) return null;
  switch (info.name) {
    case 'OracleHalted':
      return haltReasonAt(Number(info.args[1] ?? 0));
    case 'SequencerDown':
      return 'SequencerDown';
    case 'NavDisputed':
    case 'NavStale':
    case 'NoNav':
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------
// Oracle state
// ---------------------------------------------------------------------------------------

export interface NavRecord {
  valueE6: bigint;
  postedAt: number;
  observedAt: number;
  epoch: number;
  /** Snapshotted at publication, so widening the asset policy cannot revive a stale valuation. */
  maxAgeSec: number;
  accepted: number;
  distinctSigners: number;
  state: NavState;
  evidenceHash: Hex;
}

export interface AssetPolicy {
  issuer: Address;
  quorum: number;
  minDistinctSigners: number;
  bandBps: number;
  minConfidenceBps: number;
  maxAgeSec: number;
  disputeBandBps: number;
  disputeBond: bigint;
  schemaId: Hex;
  active: boolean;
}

export interface DisputeRecord {
  challenger: Address;
  bond: bigint;
  epoch: number;
  openedAt: number;
  open: boolean;
}

export interface OracleState {
  nav: NavRecord;
  usable: boolean;
  policy: AssetPolicy;
  committee: string[];
  epoch: number;
  lastHaltReason: HaltReason;
  haltCount: number;
  dispute: DisputeRecord;
  metadataURI: string;
  /** Present only when the oracle refuses; this is the exact revert a consumer would hit. */
  consumerRevert: RevertInfo | null;
  blockNumber: bigint;
  blockTimestamp: number;
}

type RawNav = {
  valueE6: bigint;
  postedAt: bigint;
  observedAt: bigint;
  epoch: number;
  maxAgeSec: number;
  accepted: number;
  distinctSigners: number;
  state: number;
  evidenceHash: Hex;
};

function toNavRecord(n: RawNav): NavRecord {
  return {
    valueE6: n.valueE6,
    postedAt: Number(n.postedAt),
    observedAt: Number(n.observedAt),
    epoch: Number(n.epoch),
    maxAgeSec: Number(n.maxAgeSec),
    accepted: Number(n.accepted),
    distinctSigners: Number(n.distinctSigners),
    state: navStateAt(Number(n.state)),
    evidenceHash: n.evidenceHash,
  };
}

/**
 * Raised when a deployment manifest names an address that holds no code.
 *
 * This happens for real: a deploy script that simulated but never broadcast still writes the
 * manifest. Reporting it as a distinct state rather than as an RPC failure is the difference
 * between a reader understanding what is wrong and assuming the dashboard is broken.
 */
export class NoContractError extends Error {
  constructor(
    readonly address: Address,
    readonly chainId: number,
  ) {
    super(`No contract at ${address} on chain ${chainId}.`);
    this.name = 'NoContractError';
  }
}

/** Confirms the manifest points at something real before any call is made against it. */
export async function assertDeployed(d: Deployment): Promise<void> {
  const code = await publicClientFor(d.chainId).getCode({ address: d.assayOracle });
  if (!code || code === '0x') throw new NoContractError(d.assayOracle, d.chainId);
}

export async function readOracleState(d: Deployment): Promise<OracleState> {
  await assertDeployed(d);
  const client = publicClientFor(d.chainId);
  const assetId = d.assetId;

  const [peek, policy, committee, epoch, halt, haltCount, dispute, metadataURI, block] =
    await Promise.all([
      client.readContract({
        address: d.assayOracle,
        abi: assayOracleAbi,
        functionName: 'peekNav',
        args: [assetId],
      }),
      client.readContract({
        address: d.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'config',
        args: [assetId],
      }),
      client.readContract({
        address: d.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'committee',
        args: [assetId],
      }),
      client.readContract({
        address: d.assayOracle,
        abi: assayOracleAbi,
        functionName: 'epochOf',
        args: [assetId],
      }),
      client.readContract({
        address: d.assayOracle,
        abi: assayOracleAbi,
        functionName: 'lastHaltReason',
        args: [assetId],
      }),
      client.readContract({
        address: d.assayOracle,
        abi: assayOracleAbi,
        functionName: 'haltCount',
        args: [assetId],
      }),
      client.readContract({
        address: d.assayOracle,
        abi: assayOracleAbi,
        functionName: 'disputes',
        args: [assetId],
      }),
      client.readContract({
        address: d.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'metadataURI',
        args: [assetId],
      }),
      client.getBlock(),
    ]);

  const [rawNav, usable] = peek as unknown as [RawNav, boolean];
  const cfg = policy as unknown as AssetPolicy;
  const [challenger, bond, dEpoch, openedAt, open] = dispute as unknown as [
    Address,
    bigint,
    number,
    bigint,
    boolean,
  ];

  // The revert is the product, so ask for it explicitly rather than inferring it from state.
  let consumerRevert: RevertInfo | null = null;
  try {
    await client.readContract({
      address: d.assayOracle,
      abi: assayOracleAbi,
      functionName: 'requireFreshNav',
      args: [assetId],
    });
  } catch (e) {
    consumerRevert = describeRevert(e);
  }

  return {
    nav: toNavRecord(rawNav),
    usable,
    policy: {
      ...cfg,
      quorum: Number(cfg.quorum),
      minDistinctSigners: Number(cfg.minDistinctSigners),
      bandBps: Number(cfg.bandBps),
      minConfidenceBps: Number(cfg.minConfidenceBps),
      maxAgeSec: Number(cfg.maxAgeSec),
      disputeBandBps: Number(cfg.disputeBandBps),
    },
    committee: committee as unknown as string[],
    epoch: Number(epoch),
    lastHaltReason: haltReasonAt(Number(halt)),
    haltCount: Number(haltCount),
    dispute: {
      challenger,
      bond,
      epoch: Number(dEpoch),
      openedAt: Number(openedAt),
      open,
    },
    metadataURI: metadataURI as unknown as string,
    consumerRevert,
    blockNumber: block.number,
    blockTimestamp: Number(block.timestamp),
  };
}

// ---------------------------------------------------------------------------------------
// Evidence: the request the contract rebuilds
// ---------------------------------------------------------------------------------------

export interface ReconstructedRequest {
  slot: number;
  model: string;
  /** The exact bytes the contract hashes for this slot. */
  request: string;
  requestHex: Hex;
}

/**
 * Asks the registry to rebuild the request for each committee slot from the evidence bytes.
 *
 * This is the same call path the oracle takes during a round, so what comes back is
 * literally the question that was put to the models — not a client-side reconstruction of it.
 */
export async function reconstructRequests(
  d: Deployment,
  evidence: string,
  committee: string[],
): Promise<ReconstructedRequest[]> {
  const client = publicClientFor(d.chainId);
  const evidenceHex = toHex(evidence);

  const results = await Promise.all(
    committee.map((model, slot) =>
      client
        .readContract({
          address: d.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'buildRequest',
          args: [d.assetId, BigInt(slot), evidenceHex],
        })
        .then((hex) => ({
          slot,
          model,
          request: hexToString(hex as Hex),
          requestHex: hex as Hex,
        })),
    ),
  );
  return results;
}

/**
 * Whether the issuer committed to this evidence digest before the round ran.
 *
 * Commitment is mandatory: a round on an uncommitted digest reverts. That split is the point —
 * the issuer commits to what the evidence *is*, the committee decides what it is *worth*, and
 * the chain checks both. Without it, whoever posts a round could choose the evidence after
 * seeing which answers it produced.
 */
export async function readEvidenceCommitment(
  d: Deployment,
  evidenceHash: Hex,
): Promise<{ committed: boolean; issuer: Address }> {
  const client = publicClientFor(d.chainId);
  const [committed, cfg] = await Promise.all([
    client.readContract({
      address: d.assetRegistry,
      abi: assetRegistryAbi,
      functionName: 'evidenceAllowed',
      args: [d.assetId, evidenceHash],
    }),
    client.readContract({
      address: d.assetRegistry,
      abi: assetRegistryAbi,
      functionName: 'config',
      args: [d.assetId],
    }),
  ]);
  return {
    committed: committed as boolean,
    issuer: (cfg as unknown as AssetPolicy).issuer,
  };
}

/** Bonds are credited, not sent, so a claim is a separate step the dispute view has to offer. */
export async function readPendingWithdrawal(d: Deployment, account: Address): Promise<bigint> {
  return (await publicClientFor(d.chainId).readContract({
    address: d.assayOracle,
    abi: assayOracleAbi,
    functionName: 'pendingWithdrawals',
    args: [account],
  })) as bigint;
}

/** The prompt fragments as stored on chain, for the evidence view's provenance strip. */
export async function readPromptSchema(d: Deployment, schemaId: Hex) {
  const client = publicClientFor(d.chainId);
  const s = (await client.readContract({
    address: d.assetRegistry,
    abi: assetRegistryAbi,
    functionName: 'schema',
    args: [schemaId],
  })) as unknown as { head: Hex; mid: Hex; tail: Hex; exists: boolean };

  return {
    head: hexToString(s.head),
    mid: hexToString(s.mid),
    tail: hexToString(s.tail),
    exists: s.exists,
  };
}

// ---------------------------------------------------------------------------------------
// Attestation registry
// ---------------------------------------------------------------------------------------

/**
 * Reads the trust root without a log scan.
 *
 * Candidate keys come from the recorded rounds — every answer names the key that signed it —
 * and each one is then confirmed against the registry itself. That keeps the view accurate on
 * a public endpoint that will not serve a wide `eth_getLogs` range.
 */
export async function readAttestation(
  d: Deployment,
  candidateSigners: Address[],
  modelsBySigner: Map<string, string[]>,
  baseline?: AttestationSnapshot | null,
): Promise<AttestationSnapshot> {
  const client = publicClientFor(d.chainId);

  const [adapterAddress, ttl, signerOffset, block] = await Promise.all([
    client.readContract({
      address: d.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: 'adapter',
    }),
    client.readContract({
      address: d.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: 'attestationTtl',
    }),
    client.readContract({
      address: d.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: 'signerOffset',
    }),
    client.getBlock(),
  ]);

  // `isTrusted` distinguishes the real verifier from the labelled stand-in. An adapter without
  // the function at all is reported as unknown rather than as false.
  let isTrusted: boolean | null = null;
  try {
    isTrusted = (await client.readContract({
      address: adapterAddress as Address,
      abi: quoteAdapterAbi,
      functionName: 'isTrusted',
    })) as boolean;
  } catch {
    isTrusted = null;
  }

  const priorByAddress = new Map(
    (baseline?.signers ?? []).map((s) => [s.address.toLowerCase(), s] as const),
  );

  const signers: AttestedSigner[] = [];
  for (const address of candidateSigners) {
    try {
      // The struct field is `measurement`; the dashboard calls it mrTd, which is what a TDX
      // quote calls it, so the rename happens here rather than in the view.
      const info = (await client.readContract({
        address: d.attestationRegistry,
        abi: attestationRegistryAbi,
        functionName: 'signerInfo',
        args: [address],
      })) as unknown as {
        measurement: Hex;
        attestedAt: bigint;
        tcbStatus: number;
        revoked: boolean;
        known: boolean;
      };
      if (!info.known) continue;

      const prior = priorByAddress.get(address.toLowerCase());
      const claimed = modelsBySigner.get(address.toLowerCase()) ?? [];
      const served: string[] = [];
      for (const model of claimed) {
        const ok = (await client.readContract({
          address: d.attestationRegistry,
          abi: attestationRegistryAbi,
          functionName: 'servesModel',
          args: [address, keccak256(toHex(model))],
        })) as boolean;
        if (ok) served.push(model);
      }

      let imageAllowed: boolean | undefined;
      try {
        imageAllowed = (await client.readContract({
          address: d.attestationRegistry,
          abi: attestationRegistryAbi,
          functionName: 'allowedImage',
          args: [info.measurement],
        })) as boolean;
      } catch {
        imageAllowed = prior?.imageAllowed;
      }

      // The registry keeps its verdict, not the transaction that produced it, so the
      // registration links come from the recorded snapshot — filtered to the models the chain
      // still confirms this key serves.
      signers.push({
        address: getAddress(address),
        mrTd: info.measurement,
        tcbStatus: Number(info.tcbStatus),
        tcbStatusLabel: tcbLabel(Number(info.tcbStatus)),
        attestedAt: Number(info.attestedAt),
        revoked: info.revoked,
        imageAllowed,
        models: served,
        registrations: (prior?.registrations ?? []).filter((r) => served.includes(r.model)),
        txHash: prior?.txHash ?? ('0x' as Hex),
        blockNumber: prior?.blockNumber ?? '',
        quoteBytes: prior?.quoteBytes ?? null,
        reportData: prior?.reportData ?? null,
      });
    } catch {
      /* an unregistered candidate is simply not part of the trust root */
    }
  }

  return {
    chainId: d.chainId,
    capturedAt: Number(block.timestamp),
    capturedAtBlock: block.number.toString(),
    adapter: {
      address: adapterAddress as Address,
      label:
        isTrusted === true
          ? 'AutomataTdxAdapter'
          : isTrusted === false
            ? 'UnverifiedQuoteAdapter'
            : 'Quote adapter',
      isTrusted: isTrusted === true,
    },
    attestationTtlSec: Number(ttl),
    signerOffset: Number(signerOffset),
    committee: baseline?.committee,
    allowedImages: baseline?.allowedImages,
    signers,
  };
}

// ---------------------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------------------

export interface VaultState {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  supplyCap: bigint;
  subscriptionsPaused: boolean;
  issuer: Address;
  currency: Address;
  currencySymbol: string;
  currencyDecimals: number;
  /** Settlement currency held by the vault, i.e. what redemptions can be paid from. */
  liquidity: bigint;
  /** Non-reverting probe. False whenever a value-moving call would revert. */
  canTransact: boolean;
  unitPriceE6: bigint | null;
  /** The revert a subscribe or redeem would hit right now, named. */
  blockedBy: RevertInfo | null;
}

export async function readVaultState(d: Deployment): Promise<VaultState> {
  await assertDeployed(d);
  const client = publicClientFor(d.chainId);
  const vault = { address: d.assayVault, abi: assayVaultAbi } as const;

  const [name, symbol, decimals, totalSupply, supplyCap, paused, issuer, currency, canTransact] =
    await Promise.all([
      client.readContract({ ...vault, functionName: 'name' }),
      client.readContract({ ...vault, functionName: 'symbol' }),
      client.readContract({ ...vault, functionName: 'decimals' }),
      client.readContract({ ...vault, functionName: 'totalSupply' }),
      client.readContract({ ...vault, functionName: 'supplyCap' }),
      client.readContract({ ...vault, functionName: 'subscriptionsPaused' }),
      client.readContract({ ...vault, functionName: 'issuer' }),
      client.readContract({ ...vault, functionName: 'currency' }),
      client.readContract({ ...vault, functionName: 'canTransact' }),
    ]);

  const currencyAddress = currency as Address;
  const [currencySymbol, currencyDecimals, liquidity] = await Promise.all([
    client.readContract({ address: currencyAddress, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: currencyAddress, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({
      address: currencyAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [d.assayVault],
    }),
  ]);

  let unitPriceE6: bigint | null = null;
  let blockedBy: RevertInfo | null = null;
  try {
    unitPriceE6 = (await client.readContract({ ...vault, functionName: 'unitPriceE6' })) as bigint;
  } catch (e) {
    blockedBy = describeRevert(e);
  }

  return {
    name: name as string,
    symbol: symbol as string,
    decimals: Number(decimals),
    totalSupply: totalSupply as bigint,
    supplyCap: supplyCap as bigint,
    subscriptionsPaused: paused as boolean,
    issuer: issuer as Address,
    currency: currencyAddress,
    currencySymbol: currencySymbol as string,
    currencyDecimals: Number(currencyDecimals),
    liquidity: liquidity as bigint,
    canTransact: canTransact as boolean,
    unitPriceE6,
    blockedBy,
  };
}

/**
 * Simulates a subscription without sending anything.
 *
 * A reader with no wallet still gets the real answer: either the shares the call would mint,
 * or the exact error the chain would raise.
 */
export async function simulateSubscribe(
  d: Deployment,
  account: Address,
  currencyIn: bigint,
): Promise<{ sharesOut: bigint } | { revert: RevertInfo | null; message: string }> {
  const client = publicClientFor(d.chainId);
  try {
    const { result } = await client.simulateContract({
      address: d.assayVault,
      abi: assayVaultAbi,
      functionName: 'subscribe',
      args: [currencyIn],
      account,
    });
    return { sharesOut: result as bigint };
  } catch (e) {
    return { revert: describeRevert(e), message: (e as Error).message.split('\n')[0]! };
  }
}

export async function simulateRedeem(
  d: Deployment,
  account: Address,
  sharesIn: bigint,
): Promise<{ currencyOut: bigint } | { revert: RevertInfo | null; message: string }> {
  const client = publicClientFor(d.chainId);
  try {
    const { result } = await client.simulateContract({
      address: d.assayVault,
      abi: assayVaultAbi,
      functionName: 'redeem',
      args: [sharesIn],
      account,
    });
    return { currencyOut: result as bigint };
  } catch (e) {
    return { revert: describeRevert(e), message: (e as Error).message.split('\n')[0]! };
  }
}
