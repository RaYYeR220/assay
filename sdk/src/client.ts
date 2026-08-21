import {
  createPublicClient,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseEventLogs,
  sha256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  assayOracleAbi,
  assayVaultAbi,
  assetRegistryAbi,
  attestationRegistryAbi,
} from './abi/index.ts';
import { addressUrl, chainById, txUrl } from './chains.ts';
import { addressesFrom, loadDeployment, tryLoadDeployment, type Deployment } from './deployments.ts';
import {
  haltReasonName,
  navStateName,
  NAV_STATE_TEXT,
  REJECT_REASON_TEXT,
  rejectReasonName,
  type HaltReason,
} from './enums.ts';
import { AssayRefusalError, explainRevert, type ExplainContext } from './errors.ts';
import { describeRange, scanLogsBackwards, type ScanOptions, type ScanResult } from './logs.ts';
import type {
  AssayAddresses,
  AssetConfig,
  AssetSummary,
  AttestedSigner,
  DisputeView,
  Nav,
  NavView,
  Refusal,
  Round,
  VaultView,
} from './types.ts';
import {
  bandAround,
  formatE6,
  median,
  type OnChainVerdict,
  type PromptSchema,
} from './verify.ts';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const satisfies Abi;

export interface AssayClientOptions {
  publicClient: PublicClient;
  addresses: AssayAddresses;
  walletClient?: WalletClient;
  /** Block to start log scans from. Without it, scans start at genesis. */
  startBlock?: bigint;
  chainId?: number;
  /** Max blocks per eth_getLogs call. X Layer caps this at 100. */
  maxLogSpan?: bigint;
  /** How far back to scan when no startBlock is known. */
  lookbackBlocks?: bigint;
}

export interface FromChainOptions {
  chainId: number;
  rpcUrl?: string;
  walletClient?: WalletClient;
  addresses?: Partial<AssayAddresses>;
  deploymentsDir?: string;
  startBlock?: bigint;
  maxLogSpan?: bigint;
  lookbackBlocks?: bigint;
}

export interface LogRange {
  fromBlock?: bigint;
  toBlock?: bigint;
}

/**
 * A typed client for the Assay oracle.
 *
 * Reads that can refuse throw {@link AssayRefusalError} with the reason already decoded;
 * reads that must not refuse return the refusal as data. Writes need a wallet client and
 * are entirely optional — most integrations only read.
 */
export class AssayClient {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly addresses: AssayAddresses;
  readonly chainId: number;
  readonly startBlock: bigint;
  readonly maxLogSpan: bigint | undefined;
  readonly lookbackBlocks: bigint | undefined;

  private committeeCache = new Map<Hex, string[]>();
  private configCache = new Map<Hex, AssetConfig>();

  constructor(options: AssayClientOptions) {
    this.publicClient = options.publicClient;
    this.walletClient = options.walletClient;
    this.addresses = options.addresses;
    this.chainId = options.chainId ?? options.publicClient.chain?.id ?? 0;
    this.startBlock = options.startBlock ?? 0n;
    this.maxLogSpan = options.maxLogSpan;
    this.lookbackBlocks = options.lookbackBlocks;
  }

  /** Build a client from a chain id, reading addresses out of `deployments/<chainId>.json`. */
  static fromChain(options: FromChainOptions): AssayClient {
    const chain = chainById(options.chainId);
    const deployment = options.addresses?.oracle
      ? tryLoadDeployment(options.chainId, options.deploymentsDir ? { dir: options.deploymentsDir } : {})
      : loadDeployment(options.chainId, options.deploymentsDir ? { dir: options.deploymentsDir } : {});

    const addresses: AssayAddresses = {
      ...(deployment ? addressesFrom(deployment) : { oracle: '0x' as Address }),
      ...options.addresses,
    } as AssayAddresses;

    const publicClient = createPublicClient({
      chain,
      transport: http(options.rpcUrl ?? chain.rpcUrls.default.http[0]),
    });

    const startBlock =
      options.startBlock ?? (deployment?.startBlock !== undefined ? BigInt(deployment.startBlock) : 0n);

    return new AssayClient({
      publicClient,
      addresses,
      chainId: options.chainId,
      startBlock,
      ...(options.maxLogSpan !== undefined ? { maxLogSpan: options.maxLogSpan } : {}),
      ...(options.lookbackBlocks !== undefined ? { lookbackBlocks: options.lookbackBlocks } : {}),
      ...(options.walletClient ? { walletClient: options.walletClient } : {}),
    });
  }

  /** Convenience for tooling that already read a deployment file. */
  static fromDeployment(
    deployment: Deployment,
    options: { rpcUrl?: string; walletClient?: WalletClient } = {},
  ): AssayClient {
    return AssayClient.fromChain({
      chainId: deployment.chainId,
      addresses: addressesFrom(deployment),
      ...options,
    });
  }

  // -------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------

  /**
   * The current attested unit price in 1e6 USD, or a throw explaining the refusal.
   *
   * This is `requireFreshNav`, which is what a consumer contract calls. If it throws, the
   * protocol is telling you not to move value; `error.refusal` says why.
   */
  async getNav(assetId: Hex): Promise<{ valueE6: bigint; value: string }> {
    try {
      const valueE6 = (await this.publicClient.readContract({
        address: this.addresses.oracle,
        abi: assayOracleAbi,
        functionName: 'requireFreshNav',
        args: [assetId],
      })) as bigint;
      return { valueE6, value: formatE6(valueE6) };
    } catch (error) {
      throw new AssayRefusalError(explainRevert(error, await this.explainContext(assetId)), error);
    }
  }

  /** Never throws. The place to look when you want the state rather than the price. */
  async peekNav(assetId: Hex): Promise<NavView> {
    let nav: Nav;
    let usable: boolean;
    try {
      const [raw, ok] = (await this.publicClient.readContract({
        address: this.addresses.oracle,
        abi: assayOracleAbi,
        functionName: 'peekNav',
        args: [assetId],
      })) as [RawNav, boolean];
      nav = decodeNav(raw);
      usable = ok;
    } catch (error) {
      // peekNav itself reverts when the asset is not listed, because it reads config.
      const refusal = explainRevert(error);
      return {
        assetId,
        valueE6: 0n,
        postedAt: 0n,
        observedAt: 0n,
        epoch: 0,
        maxAgeSec: 0,
        accepted: 0,
        distinctSigners: 0,
        state: 'Empty',
        evidenceHash: `0x${'0'.repeat(64)}`,
        usable: false,
        value: '0.000000',
        stateText: refusal.detail,
        refusal,
      };
    }

    const view: NavView = {
      ...nav,
      assetId,
      usable,
      value: formatE6(nav.valueE6),
      stateText: NAV_STATE_TEXT[nav.state],
    };

    // The window is read off the Nav, not off live config: it was snapshotted at
    // publication so an issuer cannot widen it and revive an expired valuation.
    if (nav.observedAt > 0n) {
      view.ageSec = Math.floor(Date.now() / 1000) - Number(nav.observedAt);
      view.staleAfter = Number(nav.observedAt) + nav.maxAgeSec;
    }

    if (!usable) {
      // Ask the contract itself rather than guessing which condition bit; the refusal that
      // matters is the one requireFreshNav would produce.
      view.refusal = await this.refusalFor(assetId);
      if (nav.state === 'Halted' || nav.state === 'Voided') {
        view.haltReason = await this.getLastHaltReason(assetId);
      }
    }
    return view;
  }

  /** Why a consumer cannot read this price right now, or null when it can. */
  async refusalFor(assetId: Hex): Promise<Refusal | undefined> {
    try {
      await this.publicClient.readContract({
        address: this.addresses.oracle,
        abi: assayOracleAbi,
        functionName: 'requireFreshNav',
        args: [assetId],
      });
      return undefined;
    } catch (error) {
      return explainRevert(error, await this.explainContext(assetId));
    }
  }

  async listAssets(): Promise<AssetSummary[]> {
    const registry = this.requireAssetRegistry();
    const count = (await this.publicClient.readContract({
      address: registry,
      abi: assetRegistryAbi,
      functionName: 'assetCount',
    })) as bigint;

    const ids: Hex[] = [];
    for (let i = 0n; i < count; i++) {
      ids.push(
        (await this.publicClient.readContract({
          address: registry,
          abi: assetRegistryAbi,
          functionName: 'assetAt',
          args: [i],
        })) as Hex,
      );
    }

    return Promise.all(ids.map((id) => this.getAssetSummary(id)));
  }

  async getAssetSummary(assetId: Hex): Promise<AssetSummary> {
    const registry = this.requireAssetRegistry();
    const [config, committee, metadataURI, epoch, haltCount, lastHaltReason] = await Promise.all([
      this.getAssetConfig(assetId),
      this.getCommittee(assetId),
      this.publicClient.readContract({
        address: registry,
        abi: assetRegistryAbi,
        functionName: 'metadataURI',
        args: [assetId],
      }) as Promise<string>,
      this.publicClient.readContract({
        address: this.addresses.oracle,
        abi: assayOracleAbi,
        functionName: 'epochOf',
        args: [assetId],
      }) as Promise<number>,
      this.publicClient.readContract({
        address: this.addresses.oracle,
        abi: assayOracleAbi,
        functionName: 'haltCount',
        args: [assetId],
      }) as Promise<number>,
      this.getLastHaltReason(assetId),
    ]);

    return { assetId, config, committee, metadataURI, epoch: Number(epoch), haltCount: Number(haltCount), lastHaltReason };
  }

  async getAssetConfig(assetId: Hex): Promise<AssetConfig> {
    const cached = this.configCache.get(assetId);
    if (cached) return cached;
    try {
      const raw = (await this.publicClient.readContract({
        address: this.requireAssetRegistry(),
        abi: assetRegistryAbi,
        functionName: 'config',
        args: [assetId],
      })) as AssetConfig;
      const config: AssetConfig = {
        issuer: raw.issuer,
        quorum: Number(raw.quorum),
        minDistinctSigners: Number(raw.minDistinctSigners),
        bandBps: Number(raw.bandBps),
        minConfidenceBps: Number(raw.minConfidenceBps),
        maxAgeSec: Number(raw.maxAgeSec),
        disputeBandBps: Number(raw.disputeBandBps),
        disputeBond: BigInt(raw.disputeBond),
        schemaId: raw.schemaId,
        active: raw.active,
      };
      this.configCache.set(assetId, config);
      return config;
    } catch (error) {
      throw new AssayRefusalError(explainRevert(error), error);
    }
  }

  /** The committee, in slot order. The index is the slot the contract fixes a model to. */
  async getCommittee(assetId: Hex): Promise<string[]> {
    const cached = this.committeeCache.get(assetId);
    if (cached) return cached;
    const models = (await this.publicClient.readContract({
      address: this.requireAssetRegistry(),
      abi: assetRegistryAbi,
      functionName: 'committee',
      args: [assetId],
    })) as string[];
    this.committeeCache.set(assetId, models);
    return models;
  }

  /** The prompt fragments this asset's rounds are built from, straight out of the registry. */
  async getSchema(schemaId: Hex): Promise<PromptSchema> {
    const raw = (await this.publicClient.readContract({
      address: this.requireAssetRegistry(),
      abi: assetRegistryAbi,
      functionName: 'schema',
      args: [schemaId],
    })) as { head: Hex; mid: Hex; tail: Hex; exists: boolean };
    return { head: raw.head, mid: raw.mid, tail: raw.tail, schemaId };
  }

  async getSchemaFor(assetId: Hex): Promise<PromptSchema> {
    const config = await this.getAssetConfig(assetId);
    return this.getSchema(config.schemaId);
  }

  /** Exactly the bytes the contract hashes for one committee slot. */
  async buildRequestOnChain(assetId: Hex, slot: number, evidence: Hex): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.requireAssetRegistry(),
      abi: assetRegistryAbi,
      functionName: 'buildRequest',
      args: [assetId, BigInt(slot), evidence],
    })) as Hex;
  }

  /**
   * Whether the issuer has committed to this evidence document.
   *
   * Commitment is mandatory: a round priced on evidence the issuer never stood behind is
   * rejected on chain. Check this before assembling a round, because it is the single most
   * common reason a well-formed bundle still reverts.
   */
  async isEvidenceCommitted(assetId: Hex, evidence: string | Uint8Array | Hex): Promise<boolean> {
    return this.isEvidenceHashCommitted(assetId, evidenceHashOf(evidence));
  }

  async isEvidenceHashCommitted(assetId: Hex, evidenceHash: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.requireAssetRegistry(),
      abi: assetRegistryAbi,
      functionName: 'evidenceAllowed',
      args: [assetId, evidenceHash],
    })) as boolean;
  }

  /** sha256 of an evidence document, which is the digest the registry is keyed by. */
  evidenceHash(evidence: string | Uint8Array | Hex): Hex {
    return evidenceHashOf(evidence);
  }

  /**
   * Bond money owed to an address.
   *
   * Bonds are credited rather than pushed, so a challenger contract that reverts on receive
   * cannot wedge a dispute resolution. Call {@link withdraw} to collect.
   */
  async getPendingWithdrawal(account: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.addresses.oracle,
      abi: assayOracleAbi,
      functionName: 'pendingWithdrawals',
      args: [account],
    })) as bigint;
  }
  async getLastHaltReason(assetId: Hex): Promise<HaltReason> {
    const raw = (await this.publicClient.readContract({
      address: this.addresses.oracle,
      abi: assayOracleAbi,
      functionName: 'lastHaltReason',
      args: [assetId],
    })) as number;
    const name = haltReasonName(Number(raw));
    return name === 'Unknown' ? 'None' : name;
  }

  /**
   * Every enclave key the registry has accepted, with the transaction that verified its
   * quote on chain.
   *
   * `SignerAttested` indexes the model as a hash, so model names are recovered by hashing
   * the committee membership of the listed assets. A key attested for a model no asset
   * seats will show an empty `models` list rather than a wrong one.
   *
   * The scan is bounded — see `logs.ts` for why — so the result is "every key registered in
   * the range scanned", not a claim about all of history.
   */
  async getAttestedSigners(range: LogRange = {}): Promise<AttestedSigner[]> {
    const attestations = this.requireAttestationRegistry();
    const scan = await scanLogsBackwards(this.publicClient, attestations, this.window(range));
    const events = parseEventLogs({
      abi: attestationRegistryAbi,
      logs: scan.logs,
      eventName: 'SignerAttested',
    }) as unknown as OracleEvent[];

    const modelNames = await this.knownModelNames();
    const ttl = (await this.publicClient.readContract({
      address: attestations,
      abi: attestationRegistryAbi,
      functionName: 'attestationTtl',
    })) as bigint;

    const bySigner = new Map<Address, { models: Set<string>; txHash: Hex; blockNumber: bigint }>();
    for (const log of events) {
      const args = log.args as { signer?: Address; modelIdHash?: Hex };
      if (!args.signer) continue;
      const signer = getAddress(args.signer);
      const blockNumber = log.blockNumber ?? 0n;
      const entry =
        bySigner.get(signer) ??
        { models: new Set<string>(), txHash: log.transactionHash ?? ('0x' as Hex), blockNumber };
      const name = args.modelIdHash ? modelNames.get(args.modelIdHash.toLowerCase()) : undefined;
      if (name) entry.models.add(name);
      // Keep the most recent verification, which is the one that fixes the current expiry.
      if (blockNumber >= entry.blockNumber) {
        entry.txHash = log.transactionHash ?? entry.txHash;
        entry.blockNumber = blockNumber;
      }
      bySigner.set(signer, entry);
    }

    const now = Math.floor(Date.now() / 1000);
    const out: AttestedSigner[] = [];
    for (const [signer, entry] of bySigner) {
      const info = (await this.publicClient.readContract({
        address: attestations,
        abi: attestationRegistryAbi,
        functionName: 'signerInfo',
        args: [signer],
      })) as { measurement: Hex; attestedAt: bigint; tcbStatus: number; revoked: boolean; known: boolean };

      const attestedAt = Number(info.attestedAt);
      const expiresAt = attestedAt + Number(ttl);
      const url = txUrl(this.chainId, entry.txHash);
      out.push({
        signer,
        measurement: info.measurement,
        attestedAt,
        expiresAt,
        tcbStatus: Number(info.tcbStatus),
        tcbStatusText: tcbStatusText(Number(info.tcbStatus)),
        revoked: info.revoked,
        known: info.known,
        expired: now > expiresAt,
        models: [...entry.models].sort(),
        txHash: entry.txHash,
        ...(url ? { txUrl: url } : {}),
        blockNumber: entry.blockNumber,
      });
    }
    return out.sort((a, b) => b.attestedAt - a.attestedAt);
  }

  /** modelIdHash -> model id, for every model seated on a listed asset. */
  private async knownModelNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const assets = await this.listAssets();
      for (const asset of assets) {
        for (const model of asset.committee) {
          names.set(keccak256(stringToHex(model)).toLowerCase(), model);
        }
      }
    } catch {
      // No registry configured, or nothing listed. An empty map is a fine answer.
    }
    return names;
  }

  /**
   * Rebuild one appraisal round from logs: what each seat returned, what was counted, and
   * how the round ended.
   */
  async getRound(assetId: Hex, epoch: number, range: LogRange = {}): Promise<Round> {
    const matched: OracleEvent[] = [];
    const scan = await scanLogsBackwards(
      this.publicClient,
      this.addresses.oracle,
      this.window(range),
      (batch) => {
        const mine = (
          parseEventLogs({ abi: assayOracleAbi, logs: batch }) as unknown as OracleEvent[]
        ).filter((log) => belongsTo(log, assetId, epoch));
        matched.push(...mine);
        // Every event of a round comes from one transaction, so one hit is the whole round.
        return mine.length > 0;
      },
    );
    return this.assembleRound(assetId, epoch, matched, scan);
  }

  /** The most recent rounds, newest first. */
  async getRecentRounds(assetId: Hex, count = 5, range: LogRange = {}): Promise<Round[]> {
    const byEpoch = new Map<number, OracleEvent[]>();
    const terminal = new Set<number>();

    const scan = await scanLogsBackwards(
      this.publicClient,
      this.addresses.oracle,
      this.window(range),
      (batch) => {
        for (const log of parseEventLogs({ abi: assayOracleAbi, logs: batch }) as unknown as OracleEvent[]) {
          const args = log.args as { assetId?: Hex; epoch?: number };
          if (!args.assetId || args.assetId.toLowerCase() !== assetId.toLowerCase()) continue;
          const epoch = Number(args.epoch ?? 0);
          if (!epoch) continue;
          byEpoch.set(epoch, [...(byEpoch.get(epoch) ?? []), log]);
          if (TERMINAL_EVENTS.has(log.eventName)) terminal.add(epoch);
        }
        return terminal.size >= count;
      },
    );

    const epochs = [...terminal].sort((a, b) => b - a).slice(0, count);
    return Promise.all(
      epochs.map((epoch) => this.assembleRound(assetId, epoch, byEpoch.get(epoch) ?? [], scan)),
    );
  }

  private async assembleRound(
    assetId: Hex,
    epoch: number,
    events: readonly OracleEvent[],
    scan: ScanResult,
  ): Promise<Round> {
    const committee = await this.getCommittee(assetId).catch(() => [] as string[]);
    const config = await this.getAssetConfig(assetId).catch(() => null);

    const pick = (name: string) => events.filter((log) => log.eventName === name);

    const accepted = pick('VerdictAccepted').map((log) => {
      const args = log.args as {
        slot: number;
        signer: Address;
        navE6: bigint;
        confidenceBps: bigint;
        createdAt: bigint;
      };
      const slot = Number(args.slot);
      return {
        slot,
        ...(committee[slot] ? { modelId: committee[slot]! } : {}),
        signer: getAddress(args.signer),
        navE6: args.navE6,
        value: formatE6(args.navE6),
        confidenceBps: Number(args.confidenceBps),
        createdAt: Number(args.createdAt),
      };
    });

    const rejected = pick('VerdictRejected').map((log) => {
      const args = log.args as { slot: number; signer: Address; reason: number };
      const slot = Number(args.slot);
      const reason = rejectReasonName(Number(args.reason));
      return {
        slot,
        ...(committee[slot] ? { modelId: committee[slot]! } : {}),
        signer: getAddress(args.signer),
        reason,
        detail: reason === 'Unknown' ? 'rejection code ' + String(args.reason) : REJECT_REASON_TEXT[reason],
      };
    });

    accepted.sort((a, b) => a.slot - b.slot);
    rejected.sort((a, b) => a.slot - b.slot);

    const round: Round = { assetId, epoch, outcome: 'unknown', summary: '', accepted, rejected };
    if (config) {
      round.quorum = config.quorum;
      round.minDistinctSigners = config.minDistinctSigners;
    }

    const posted = pick('AppraisalPosted')[0];
    const halted = pick('Halted')[0];
    const ignored = pick('RoundIgnored')[0];

    if (posted) {
      const args = posted.args as {
        valueE6: bigint;
        distinctSigners: number;
        observedAt: bigint;
        evidenceHash: Hex;
      };
      round.outcome = 'published';
      round.medianE6 = args.valueE6;
      round.median = formatE6(args.valueE6);
      round.distinctSigners = Number(args.distinctSigners);
      round.observedAt = Number(args.observedAt);
      round.evidenceHash = args.evidenceHash;
      round.blockNumber = posted.blockNumber ?? undefined;
      round.txHash = posted.transactionHash ?? undefined;
      if (config) round.band = bandAround(args.valueE6, config.bandBps);
      round.summary =
        'epoch ' + epoch + ': ' + accepted.length + ' of ' + (accepted.length + rejected.length) +
        ' seats counted, median ' + formatE6(args.valueE6) + ' USD published';
    } else if (halted) {
      const args = halted.args as { reason: number; accepted: number; evidenceHash: Hex };
      const reason = haltReasonName(Number(args.reason));
      round.outcome = 'halted';
      round.haltReason = reason === 'Unknown' ? undefined : reason;
      round.haltReasonText = reason === 'Unknown' ? 'halt code ' + String(args.reason) : haltText(reason);
      round.evidenceHash = args.evidenceHash;
      round.blockNumber = halted.blockNumber ?? undefined;
      round.txHash = halted.transactionHash ?? undefined;
      if (accepted.length > 1) {
        const value = median(accepted.map((a) => a.navE6));
        round.medianE6 = value;
        round.median = formatE6(value);
        if (config) round.band = bandAround(value, config.bandBps);
      }
      round.summary = 'epoch ' + epoch + ': HALT - ' + round.haltReasonText;
    } else if (ignored) {
      const args = ignored.args as { authenticated: number; evidenceHash: Hex };
      round.outcome = 'ignored';
      round.authenticated = Number(args.authenticated);
      round.evidenceHash = args.evidenceHash;
      round.blockNumber = ignored.blockNumber ?? undefined;
      round.txHash = ignored.transactionHash ?? undefined;
      round.summary =
        'epoch ' + epoch + ': ignored - only ' + args.authenticated +
        ' answers carried a valid enclave signature';
    } else {
      round.summary = 'epoch ' + epoch + ': no round found in ' + describeRange(scan);
    }

    if (round.txHash) {
      const url = txUrl(this.chainId, round.txHash);
      if (url) round.txUrl = url;
    }

    // Deviation from the round's own median, which is what the band is measured against.
    if (round.medianE6 && round.medianE6 > 0n) {
      for (const entry of round.accepted) {
        const delta = entry.navE6 - round.medianE6;
        (entry as { deviationBps?: number }).deviationBps = Number((delta * 10_000n) / round.medianE6);
      }
    }

    return round;
  }

  /** Turn caller-supplied bounds into a scan window, honouring the deployment's startBlock. */
  private window(range: LogRange): ScanOptions {
    const options: ScanOptions = {};
    const from = range.fromBlock ?? (this.startBlock > 0n ? this.startBlock : undefined);
    if (from !== undefined) options.fromBlock = from;
    if (range.toBlock !== undefined) options.toBlock = range.toBlock;
    if (this.maxLogSpan !== undefined) options.maxSpan = this.maxLogSpan;
    if (this.lookbackBlocks !== undefined) options.lookback = this.lookbackBlocks;
    return options;
  }

  async getDispute(assetId: Hex): Promise<DisputeView> {
    const [challenger, bond, epoch, openedAt, open] = (await this.publicClient.readContract({
      address: this.addresses.oracle,
      abi: assayOracleAbi,
      functionName: 'disputes',
      args: [assetId],
    })) as [Address, bigint, number, bigint, boolean];

    const view: DisputeView = {
      assetId,
      open,
      challenger,
      bond,
      epoch: Number(epoch),
      openedAt: Number(openedAt),
    };
    if (open) view.contestedEpoch = Number(epoch);
    return view;
  }

  /** How long a challenge must stand before it can lapse. */
  async getChallengeWindow(): Promise<number> {
    const window = (await this.publicClient.readContract({
      address: this.addresses.oracle,
      abi: assayOracleAbi,
      functionName: 'challengeWindow',
    })) as bigint;
    return Number(window);
  }

  /** The newest response timestamp the oracle has already counted for this asset. */
  async getObservationWatermark(assetId: Hex): Promise<number> {
    const watermark = (await this.publicClient.readContract({
      address: this.addresses.oracle,
      abi: assayOracleAbi,
      functionName: 'observationWatermark',
      args: [assetId],
    })) as bigint;
    return Number(watermark);
  }

  async getVault(address?: Address): Promise<VaultView> {
    const vault = address ?? this.addresses.vault;
    if (!vault) throw new Error('no vault address configured; pass one or add assayVault to the deployment file');

    const [name, symbol, assetId, issuer, totalSupply, supplyCap, currency, currencyDecimals, subscriptionsPaused] =
      (await Promise.all([
        this.readVault(vault, 'name'),
        this.readVault(vault, 'symbol'),
        this.readVault(vault, 'assetId'),
        this.readVault(vault, 'issuer'),
        this.readVault(vault, 'totalSupply'),
        this.readVault(vault, 'supplyCap'),
        this.readVault(vault, 'currency'),
        this.readVault(vault, 'currencyDecimals'),
        this.readVault(vault, 'subscriptionsPaused'),
      ])) as [string, string, Hex, Address, bigint, bigint, Address, number, boolean];

    const liquidity = (await this.publicClient.readContract({
      address: currency,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [vault],
    })) as bigint;

    const view: VaultView = {
      address: vault,
      name,
      symbol,
      assetId,
      issuer,
      totalSupply,
      supplyCap,
      liquidity,
      currency,
      currencyDecimals: Number(currencyDecimals),
      subscriptionsPaused,
      canTransact: false,
    };

    try {
      const priceE6 = (await this.publicClient.readContract({
        address: vault,
        abi: assayVaultAbi,
        functionName: 'unitPriceE6',
      })) as bigint;
      view.sharePriceE6 = priceE6;
      view.sharePrice = formatE6(priceE6);
      view.canTransact = true;
    } catch (error) {
      view.refusal = explainRevert(error, await this.explainContext(assetId));
    }

    return view;
  }

  private readVault(vault: Address, functionName: string) {
    return this.publicClient.readContract({ address: vault, abi: assayVaultAbi, functionName } as never);
  }

  // -------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------

  /** Post a full committee round. Returns whether the oracle published a price. */
  async postAppraisal(assetId: Hex, evidence: Hex, verdicts: readonly OnChainVerdict[]): Promise<Hex> {
    return this.write(assayOracleAbi, this.addresses.oracle, 'postAppraisal', [assetId, evidence, verdicts]);
  }

  /** Simulate a round without spending gas. Returns `published`, or throws the decoded revert. */
  async simulateAppraisal(assetId: Hex, evidence: Hex, verdicts: readonly OnChainVerdict[]): Promise<boolean> {
    try {
      const { result } = await this.publicClient.simulateContract({
        address: this.addresses.oracle,
        abi: assayOracleAbi,
        functionName: 'postAppraisal',
        args: [assetId, evidence, verdicts as never],
        account: this.walletClient?.account ?? undefined,
      });
      return result as boolean;
    } catch (error) {
      throw new AssayRefusalError(explainRevert(error, await this.explainContext(assetId)), error);
    }
  }

  async challenge(assetId: Hex, bondWei: bigint): Promise<Hex> {
    return this.write(assayOracleAbi, this.addresses.oracle, 'challenge', [assetId], bondWei);
  }

  async resolveDispute(assetId: Hex, evidence: Hex, verdicts: readonly OnChainVerdict[]): Promise<Hex> {
    return this.write(assayOracleAbi, this.addresses.oracle, 'resolveDispute', [assetId, evidence, verdicts]);
  }

  /** Close a challenge nobody resolved before the window expired. */
  async lapseDispute(assetId: Hex): Promise<Hex> {
    return this.write(assayOracleAbi, this.addresses.oracle, 'lapseDispute', [assetId]);
  }

  /** Collect bond money credited to you by a dispute resolution. */
  async withdraw(): Promise<Hex> {
    return this.write(assayOracleAbi, this.addresses.oracle, 'withdraw', []);
  }
  async subscribe(currencyIn: bigint, vault?: Address): Promise<Hex> {
    return this.write(assayVaultAbi, this.requireVault(vault), 'subscribe', [currencyIn]);
  }

  async redeem(sharesIn: bigint, vault?: Address): Promise<Hex> {
    return this.write(assayVaultAbi, this.requireVault(vault), 'redeem', [sharesIn]);
  }

  /**
   * Register a prompt schema. Content-addressed and permissionless: the id is derived from
   * the fragments, so registering the same question twice is a no-op that reverts.
   */
  async registerSchema(head: Hex, mid: Hex, tail: Hex): Promise<Hex> {
    return this.write(assetRegistryAbi, this.requireAssetRegistry(), 'registerSchema', [head, mid, tail]);
  }

  /** The schema id these fragments will get, computed by the registry itself. */
  async schemaIdOf(head: Hex, mid: Hex, tail: Hex): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.requireAssetRegistry(),
      abi: assetRegistryAbi,
      functionName: 'schemaIdOf',
      args: [head, mid, tail],
    })) as Hex;
  }

  async registerAsset(
    assetId: Hex,
    config: AssetConfig,
    models: readonly string[],
    metadataURI: string,
  ): Promise<Hex> {
    return this.write(assetRegistryAbi, this.requireAssetRegistry(), 'registerAsset', [
      assetId,
      config,
      models,
      metadataURI,
    ]);
  }

  /** Commit to an evidence document ahead of the round that prices against it. */
  async commitEvidence(assetId: Hex, evidenceHash: Hex, uri: string, allowed = true): Promise<Hex> {
    return this.write(assetRegistryAbi, this.requireAssetRegistry(), 'commitEvidence', [
      assetId,
      evidenceHash,
      uri,
      allowed,
    ]);
  }

  /**
   * Verify a TDX quote on chain and bind the key inside it to a model.
   *
   * Owner-gated, which looks like a centralisation smell and is not one. The signer address
   * is still read out of the verified quote and cannot be named by anyone, owner included.
   * What the owner asserts is the other half of the record: a TDX quote proves which image
   * is running and which key it holds, but says nothing about which model that image fronts,
   * so the key-to-model binding is a curator assertion. Gating it keeps that assertion
   * explicit instead of letting anyone mint one and call it an attestation.
   */
  async registerSigner(rawQuote: Hex, modelId: string): Promise<Hex> {
    return this.write(attestationRegistryAbi, this.requireAttestationRegistry(), 'registerSigner', [
      rawQuote,
      modelId,
    ]);
  }

  private async write(
    abi: Abi | readonly unknown[],
    address: Address,
    functionName: string,
    args: readonly unknown[],
    value?: bigint,
  ): Promise<Hex> {
    const wallet = this.walletClient;
    if (!wallet) throw new Error(`${functionName} needs a wallet client; construct AssayClient with one`);
    const account = wallet.account;
    if (!account) throw new Error(`${functionName} needs an account on the wallet client`);

    try {
      const { request } = await this.publicClient.simulateContract({
        address,
        abi: abi as Abi,
        functionName,
        args,
        account,
        ...(value !== undefined ? { value } : {}),
      });
      return await wallet.writeContract(request as never);
    } catch (error) {
      throw new AssayRefusalError(explainRevert(error), error);
    }
  }

  // -------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------

  /** Pull the numbers that let a refusal name the real band and window. Best effort. */
  private async explainContext(assetId: Hex): Promise<ExplainContext> {
    try {
      const config = await this.getAssetConfig(assetId);
      return {
        assetId,
        bandBps: config.bandBps,
        disputeBandBps: config.disputeBandBps,
        maxAgeSec: config.maxAgeSec,
      };
    } catch {
      return { assetId };
    }
  }

  private requireAssetRegistry(): Address {
    const address = this.addresses.assetRegistry;
    if (!address) throw new Error('no AssetRegistry address configured');
    return address;
  }

  private requireAttestationRegistry(): Address {
    const address = this.addresses.attestationRegistry;
    if (!address) throw new Error('no AttestationRegistry address configured');
    return address;
  }

  private requireVault(vault?: Address): Address {
    const address = vault ?? this.addresses.vault;
    if (!address) throw new Error('no AssayVault address configured');
    return address;
  }

  explorerUrlFor(address: Address): string | undefined {
    return addressUrl(this.chainId, address);
  }
}

/** A decoded contract event, loosely typed so one helper can handle every event shape. */
interface OracleEvent {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
}

/** The events that end a round; every other event in a round is a per-seat detail. */
const TERMINAL_EVENTS = new Set(['AppraisalPosted', 'Halted', 'RoundIgnored']);

function belongsTo(log: OracleEvent, assetId: Hex, epoch: number): boolean {
  const args = log.args as { assetId?: Hex; epoch?: number };
  return (
    args.assetId !== undefined &&
    args.assetId.toLowerCase() === assetId.toLowerCase() &&
    Number(args.epoch ?? -1) === epoch
  );
}

interface RawNav {
  valueE6: bigint;
  postedAt: bigint;
  observedAt: bigint;
  epoch: number;
  maxAgeSec: number;
  accepted: number;
  distinctSigners: number;
  state: number;
  evidenceHash: Hex;
}

/** The registry keys committed evidence by sha256, matching what the oracle hashes. */
function evidenceHashOf(evidence: string | Uint8Array | Hex): Hex {
  if (typeof evidence === 'string' && evidence.startsWith('0x')) return sha256(hexToBytes(evidence as Hex));
  return sha256(typeof evidence === 'string' ? new TextEncoder().encode(evidence) : evidence);
}

function decodeNav(raw: RawNav): Nav {
  const state = navStateName(Number(raw.state));
  return {
    valueE6: BigInt(raw.valueE6),
    postedAt: BigInt(raw.postedAt),
    observedAt: BigInt(raw.observedAt),
    epoch: Number(raw.epoch),
    maxAgeSec: Number(raw.maxAgeSec),
    accepted: Number(raw.accepted),
    distinctSigners: Number(raw.distinctSigners),
    state: state === 'Unknown' ? 'Empty' : state,
    evidenceHash: raw.evidenceHash,
  };
}

function haltText(reason: HaltReason): string {
  return reason === 'Disagreement'
    ? 'the surviving answers disagreed by more than the band'
    : reason === 'InsufficientQuorum'
      ? 'too few answers survived verification to reach quorum'
      : reason === 'SequencerDown'
        ? 'the sequencer uptime feed was unhealthy'
        : reason === 'AssetInactive'
          ? 'the asset was not active'
          : reason === 'Unauthenticated'
            ? 'too few answers carried a valid enclave signature'
            : 'no halt';
}

function tcbStatusText(status: number): string {
  // Intel's own ordering; 0 is the only status the registry accepts out of the box.
  const names = ['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate', 'OutOfDateConfigurationNeeded', 'Revoked'];
  return names[status] ?? `status ${status}`;
}

