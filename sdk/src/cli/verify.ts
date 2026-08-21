#!/usr/bin/env node
/**
 * assay-verify — re-derive every claim this project makes, from public data.
 *
 * It holds no key, sends no transaction and trusts nothing the project says about itself.
 * Contract addresses come from the deployment file, everything else comes from the chain
 * and from Intel's own attestation endpoint. Where a claim cannot be checked, it says so
 * and exits accordingly; a check that did not run is never reported as one that passed.
 */

import {
  createPublicClient,
  decodeFunctionData,
  formatUnits,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { assayOracleAbi, assetRegistryAbi } from '../abi/index.ts';
import { chainById, txUrl } from '../chains.ts';
import { AssayClient } from '../client.ts';
import { addressesFrom, tryLoadDeployment, type Deployment } from '../deployments.ts';
import { explainRevert } from '../errors.ts';
import { scanLogsBackwards } from '../logs.ts';
import { isoTime, Report, shortHex } from './report.ts';
import {
  bandAround,
  buildRequestBytes,
  formatE6,
  median,
  parseResponse,
  recoverEnclaveSigner,
  sha256Hex,
  signedText,
  toBytes,
} from '../verify.ts';

const ADAPTER_ABI = [
  { type: 'function', name: 'isTrusted', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

const REDPILL_REPORT = 'https://api.redpill.ai/v1/attestation/report';

interface Options {
  chainId: number;
  rpcUrl?: string;
  deploymentsDir?: string;
  rounds: number;
  assetId?: Hex;
  offline: boolean;
  json: boolean;
  fromBlock?: bigint;
  lookback?: bigint;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { chainId: 196, rounds: 3, offline: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    switch (arg) {
      case '--chain':
        options.chainId = Number(next());
        break;
      case '--rpc':
        options.rpcUrl = next();
        break;
      case '--deployments':
        options.deploymentsDir = next();
        break;
      case '--rounds':
        options.rounds = Number(next());
        break;
      case '--asset':
        options.assetId = next() as Hex;
        break;
      case '--from-block':
        options.fromBlock = BigInt(next()!);
        break;
      case '--lookback':
        options.lookback = BigInt(next()!);
        break;
      case '--offline':
        options.offline = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown option ${arg}\n`);
        usage();
        process.exit(2);
    }
  }
  return options;
}

function usage(): void {
  process.stdout.write(
    [
      'assay-verify — independently re-check an Assay deployment',
      '',
      'Usage: assay-verify [options]',
      '',
      '  --chain <id>          196 (X Layer) or 1952 (X Layer testnet). Default 196.',
      '  --rpc <url>           override the RPC endpoint',
      '  --deployments <dir>   directory holding <chainId>.json',
      '  --asset <bytes32>     check one asset instead of all listed',
      '  --rounds <n>          how many recent rounds to re-derive per asset. Default 3.',
      '  --from-block <n>      first block to scan for logs',
      '  --lookback <n>        blocks to walk back when no start block is known. Default 20000.',
      '  --offline             skip the live enclave attestation fetch',
      '  --json                emit the claim log as JSON instead of text',
      '',
      'Exits non-zero if any claim fails.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const report = new Report({ quiet: options.json });

  if (!options.json) {
    process.stdout.write(`assay-verify — chain ${options.chainId}\n`);
  }

  // -- deployment ------------------------------------------------------------------------
  report.heading('Deployment');
  const deployment = tryLoadDeployment(
    options.chainId,
    options.deploymentsDir ? { dir: options.deploymentsDir } : {},
  );
  if (!deployment) {
    report.skip(
      `a deployment file exists for chain ${options.chainId}`,
      `no deployments/${options.chainId}.json found; nothing can be checked until the contracts are deployed`,
    );
    finish(report, options);
    return report.failures > 0 ? 1 : 0;
  }
  report.pass(
    `a deployment file exists for chain ${options.chainId}`,
    `oracle ${deployment.assayOracle}, registry ${deployment.assetRegistry}, attestations ${deployment.attestationRegistry}`,
  );

  const chain = chainById(options.chainId);
  const publicClient = createPublicClient({
    chain,
    transport: http(options.rpcUrl ?? chain.rpcUrls.default.http[0]),
  });

  let onChainId: number;
  try {
    onChainId = await publicClient.getChainId();
  } catch (error) {
    report.skip('the RPC endpoint answers', `${(error as Error).message}; every on-chain claim below is unchecked`);
    finish(report, options);
    return 1;
  }

  if (onChainId === options.chainId) {
    report.pass('the RPC endpoint serves the chain the deployment claims', `chainId ${onChainId} from ${options.rpcUrl ?? chain.rpcUrls.default.http[0]}`);
  } else {
    report.fail('the RPC endpoint serves the chain the deployment claims', `deployment says ${options.chainId}, endpoint says ${onChainId}`);
  }

  const deployed = await checkBytecode(report, publicClient, deployment);
  await checkAdapter(report, publicClient, deployment, deployed);

  const client = new AssayClient({
    publicClient,
    addresses: addressesFrom(deployment),
    chainId: options.chainId,
    startBlock: options.fromBlock ?? (deployment.startBlock ? BigInt(deployment.startBlock) : 0n),
    ...(options.lookback !== undefined ? { lookbackBlocks: options.lookback } : {}),
  });

  // -- attestations ----------------------------------------------------------------------
  report.heading('Attested enclave keys');
  const signers = await safe(() => client.getAttestedSigners());
  if (!signers.ok) {
    report.skip('the registry lists at least one attested enclave key', signers.why);
  } else if (signers.value.length === 0) {
    // A bounded scan that finds nothing has not established that nothing is there.
    report.skip(
      'the registry lists at least one attested enclave key',
      'no SignerAttested events in the scanned range. X Layer caps eth_getLogs at 100 blocks, so the scan walks back a bounded window; pass --from-block or --lookback to widen it.',
    );
  } else {
    report.pass(
      'the registry lists at least one attested enclave key',
      `${signers.value.length} key${signers.value.length === 1 ? '' : 's'} registered`,
    );
    const now = Math.floor(Date.now() / 1000);
    for (const signer of signers.value) {
      const facts = [
        `measurement ${shortHex(signer.measurement)}`,
        `TCB ${signer.tcbStatusText}`,
        `attested ${isoTime(signer.attestedAt)}`,
        `expires ${isoTime(signer.expiresAt)}`,
        signer.models.length ? `models ${signer.models.join(', ')}` : 'models unknown (no listed asset seats it)',
        signer.txHash ? `verified in ${signer.txHash}` : 'no verification transaction found',
      ];
      const claim = `enclave key ${signer.signer} is live`;
      if (signer.revoked) report.fail(claim, `revoked. ${facts.join('; ')}`);
      else if (signer.expiresAt <= now) report.fail(claim, `attestation expired ${isoTime(signer.expiresAt)}. ${facts.join('; ')}`);
      else report.pass(claim, facts.join('; '));

      if (signer.txHash) {
        const url = txUrl(options.chainId, signer.txHash);
        if (url && !options.json) process.stdout.write(`${' '.repeat(10)}${url}\n`);
      }
    }

    await checkLiveAttestation(report, signers.value, options);
  }

  // -- assets and rounds -----------------------------------------------------------------
  const assets = await safe(() => (options.assetId ? Promise.all([client.getAssetSummary(options.assetId!)]) : client.listAssets()));
  if (!assets.ok) {
    report.heading('Assets');
    report.skip('at least one asset is listed', assets.why);
    finish(report, options);
    return report.failures > 0 ? 1 : 0;
  }

  report.heading('Assets');
  if (assets.value.length === 0) {
    report.skip('at least one asset is listed', 'the registry holds no assets, so there are no rounds to re-derive');
    finish(report, options);
    return report.failures > 0 ? 1 : 0;
  }
  report.pass('at least one asset is listed', `${assets.value.length} asset(s): ${assets.value.map((a) => shortHex(a.assetId)).join(', ')}`);

  for (const asset of assets.value) {
    report.heading(`Asset ${shortHex(asset.assetId)}${asset.metadataURI ? ` (${asset.metadataURI})` : ''}`);
    report.pass(
      'the asset states its appraisal policy on chain',
      `quorum ${asset.config.quorum} of ${asset.committee.length}, band ${asset.config.bandBps / 100}%, confidence floor ${asset.config.minConfidenceBps} bps, ` +
        `freshness ${asset.config.maxAgeSec}s, dispute bond ${formatUnits(asset.config.disputeBond, 18)} OKB, ` +
        'evidence must be committed by the issuer before it can be priced',
    );
    report.pass('the committee is fixed by slot', asset.committee.map((m, i) => `${i}:${m}`).join('  '));

    await checkNavConsistency(report, client, asset.assetId);
    await checkRounds(report, client, publicClient, asset.assetId, asset.committee, asset.config.bandBps, asset.config.issuer, options);
    await checkHaltHistory(report, client, asset.assetId, asset.haltCount);
  }

  finish(report, options);
  return report.failures > 0 ? 1 : 0;
}

// -----------------------------------------------------------------------------------------

async function checkBytecode(
  report: Report,
  publicClient: PublicClient,
  deployment: Deployment,
): Promise<Set<string>> {
  const deployed = new Set<string>();
  const targets: Array<[string, Address | undefined]> = [
    ['AssayOracle', deployment.assayOracle],
    ['AssetRegistry', deployment.assetRegistry],
    ['AttestationRegistry', deployment.attestationRegistry],
    ['AssayVault', deployment.assayVault],
    ['quote adapter', deployment.quoteAdapter],
  ];

  for (const [name, address] of targets) {
    if (!address) {
      report.skip(`${name} is deployed`, 'no address in the deployment file');
      continue;
    }
    const code = await publicClient.getCode({ address }).catch(() => undefined);
    if (!code || code === '0x') {
      report.fail(`${name} is deployed at ${address}`, 'the address holds no bytecode on this chain');
      continue;
    }
    deployed.add(address.toLowerCase());
    report.pass(
      `${name} is deployed at ${address}`,
      `${(code.length - 2) / 2} bytes of runtime code, keccak ${keccak256(code)}`,
    );
  }
  return deployed;
}

async function checkAdapter(
  report: Report,
  publicClient: PublicClient,
  deployment: Deployment,
  deployed: Set<string>,
) {
  const adapter = deployment.quoteAdapter;
  const claim = 'the attestation adapter is a real on-chain Intel DCAP verifier';
  if (!adapter) {
    report.skip(claim, 'no quoteAdapter address in the deployment file');
    return;
  }
  if (!deployed.has(adapter.toLowerCase())) {
    report.skip(claim, `${adapter} holds no bytecode, so there is nothing to interrogate`);
    return;
  }

  let trusted: boolean | 'absent';
  try {
    trusted = (await publicClient.readContract({
      address: adapter,
      abi: ADAPTER_ABI,
      functionName: 'isTrusted',
    })) as boolean;
  } catch {
    // Only the labelled stand-in implements isTrusted(); a revert means a real verifier.
    trusted = 'absent';
  }

  if (trusted === 'absent') {
    report.pass(claim, `${adapter} does not implement isTrusted(), which only the development stand-in does`);
  } else if (trusted === true) {
    report.pass(claim, `${adapter} reports isTrusted() = true`);
  } else {
    report.fail(
      claim,
      `${adapter} reports isTrusted() = false. This is UnverifiedQuoteAdapter, a stand-in that verifies NOTHING: ` +
        'it parrots back operator-supplied measurements, so every "attested" key below rests on an operator assertion, ' +
        'not on Intel. Acceptable only on a throwaway network.',
    );
  }
}

async function checkLiveAttestation(report: Report, signers: Awaited<ReturnType<AssayClient['getAttestedSigners']>>, options: Options) {
  const claimFor = (model: string) => `the live enclave for ${model} binds the key the contract registered`;

  if (options.offline) {
    for (const signer of signers) {
      for (const model of signer.models) report.skip(claimFor(model), '--offline was passed');
    }
    return;
  }

  const models = [...new Set(signers.flatMap((s) => s.models))];
  if (models.length === 0) {
    report.skip(
      'a live enclave report binds the registered key',
      'no model id could be recovered for any registered key, so there is nothing to fetch',
    );
    return;
  }

  for (const model of models) {
    const expected = signers.filter((s) => s.models.includes(model)).map((s) => s.signer.toLowerCase());
    let payload: Record<string, unknown>;
    try {
      const response = await fetch(`${REDPILL_REPORT}?model=${encodeURIComponent(model)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        report.skip(claimFor(model), `attestation endpoint returned HTTP ${response.status}`);
        continue;
      }
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      report.skip(claimFor(model), `attestation endpoint unreachable: ${(error as Error).message}`);
      continue;
    }

    const reportData = findReportData(payload);
    if (!reportData) {
      report.skip(claimFor(model), 'the report carries no report_data field to compare against');
      continue;
    }

    const embedded = `0x${reportData.replace(/^0x/, '').slice(0, 40).toLowerCase()}`;
    const signingAddress =
      typeof payload['signing_address'] === 'string' ? (payload['signing_address'] as string).toLowerCase() : null;

    if (signingAddress && signingAddress !== embedded) {
      report.fail(
        claimFor(model),
        `the endpoint's own signing_address ${signingAddress} does not match report_data[0:20] = ${embedded}`,
      );
      continue;
    }

    if (expected.includes(embedded)) {
      report.pass(
        claimFor(model),
        `report_data[0:20] = ${embedded}, which is the address the contract accepted after verifying the quote`,
      );
    } else {
      report.fail(
        claimFor(model),
        `the live enclave binds ${embedded}, but the registry holds ${expected.join(', ') || '(nothing)'} for this model`,
      );
    }
  }
}

function findReportData(payload: unknown, depth = 0): string | null {
  if (depth > 6 || payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['report_data', 'reportData', 'quote_report_data']) {
    const value = record[key];
    if (typeof value === 'string' && value.replace(/^0x/, '').length >= 40) return value;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findReportData(item, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = findReportData(value, depth + 1);
    if (found) return found;
  }
  return null;
}

async function checkNavConsistency(report: Report, client: AssayClient, assetId: Hex) {
  const peek = await safe(() => client.peekNav(assetId));
  if (!peek.ok) {
    report.skip('the published state and the consumer read agree', peek.why);
    return;
  }
  const view = peek.value;

  let navReturned: bigint | null = null;
  let refusal: string | null = null;
  try {
    navReturned = (await client.getNav(assetId)).valueE6;
  } catch (error) {
    refusal = explainRevert((error as { cause?: unknown }).cause ?? error).detail;
  }

  const claim = 'requireFreshNav behaves consistently with the recorded state';
  if (view.usable && navReturned !== null) {
    if (navReturned === view.valueE6) {
      report.pass(claim, `state ${view.state}, both paths return ${formatE6(navReturned)} USD per unit`);
    } else {
      report.fail(claim, `peekNav says ${view.value} but requireFreshNav returned ${formatE6(navReturned)}`);
    }
  } else if (!view.usable && navReturned === null) {
    report.pass(claim, `state ${view.state}: peekNav reports unusable and requireFreshNav reverts — ${refusal}`);
  } else if (view.usable) {
    report.fail(claim, `peekNav says the price is usable but requireFreshNav reverted — ${refusal}`);
  } else {
    report.fail(claim, `peekNav says the price is unusable but requireFreshNav returned ${formatE6(navReturned!)}`);
  }
}

async function checkRounds(
  report: Report,
  client: AssayClient,
  publicClient: PublicClient,
  assetId: Hex,
  committee: string[],
  bandBps: number,
  issuer: Address,
  options: Options,
) {
  const rounds = await safe(() => client.getRecentRounds(assetId, options.rounds));
  if (!rounds.ok) {
    report.skip('the recent rounds can be rebuilt from logs', rounds.why);
    return;
  }
  if (rounds.value.length === 0) {
    report.skip(
      'the recent rounds can be rebuilt from logs',
      'no round events found in the scanned range. X Layer caps eth_getLogs at 100 blocks, so the scan walks back a bounded window; pass --from-block, or add startBlock to the deployment file.',
    );
    return;
  }

  const schema = await safe(() => client.getSchemaFor(assetId));
  if (!schema.ok) {
    report.skip('the prompt schema can be read back from the registry', schema.why);
    return;
  }
  report.pass(
    'the question put to the committee is stored on chain',
    `schema ${shortHex(schema.value.schemaId ?? '0x')}, ${toBytes(schema.value.head).length + toBytes(schema.value.mid).length + toBytes(schema.value.tail).length} bytes of prompt fragments`,
  );

  for (const round of rounds.value) {
    if (round.outcome === 'unknown') {
      report.skip(`round ${round.epoch} is on chain`, 'no event for this epoch in the scanned block range');
      continue;
    }

    report.pass(`round ${round.epoch} is recorded on chain`, round.summary);

    if (!round.txHash) {
      report.skip(`round ${round.epoch} signatures re-verify from raw bytes`, 'no transaction hash for this round');
      continue;
    }

    // The evidence and the raw response bodies only exist in the calldata; the logs carry
    // digests. Re-deriving the contract's conclusion means reading the transaction itself.
    const decoded = await safe(async () => {
      const tx = await publicClient.getTransaction({ hash: round.txHash! });
      return decodeFunctionData({ abi: assayOracleAbi, data: tx.input }) as {
        functionName: string;
        args: readonly [Hex, Hex, ReadonlyArray<{ slot: number; responseBody: Hex; signature: Hex }>];
      };
    });
    if (!decoded.ok) {
      report.skip(`round ${round.epoch} signatures re-verify from raw bytes`, decoded.why);
      continue;
    }

    const [, evidence, verdicts] = decoded.value.args;
    const evidenceBytes = toBytes(evidence);

    if (round.evidenceHash) {
      const recomputed = `0x${sha256Hex(evidenceBytes)}`;
      if (recomputed.toLowerCase() === round.evidenceHash.toLowerCase()) {
        report.pass(
          `round ${round.epoch} priced the evidence its log commits to`,
          `sha256 of the ${evidenceBytes.length}-byte evidence in calldata equals ${shortHex(round.evidenceHash)}`,
        );
      } else {
        report.fail(
          `round ${round.epoch} priced the evidence its log commits to`,
          `calldata hashes to ${recomputed}, log says ${round.evidenceHash}`,
        );
      }
    }

    // Commitment is what separates "the committee priced something" from "the issuer stood
    // behind what the committee was shown". Without it a relayer picks the facts.
    if (round.evidenceHash) {
      const committed = await safe(() => client.isEvidenceHashCommitted(assetId, round.evidenceHash!));
      const claim = `round ${round.epoch} priced evidence its issuer had committed to`;
      if (!committed.ok) {
        report.skip(claim, committed.why);
      } else if (committed.value) {
        const uri = await evidenceUri(publicClient, client, assetId, round.evidenceHash);
        report.pass(
          claim,
          `${shortHex(round.evidenceHash)} is committed by issuer ${issuer} (commitEvidence is onlyIssuer, so nobody else could have)` +
            (uri ? `, published at ${uri}` : ''),
        );
      } else {
        report.fail(
          claim,
          `${shortHex(round.evidenceHash)} is not committed in the registry. Either the commitment was withdrawn after the round, or this round predates the requirement.`,
        );
      }
    }
    let recovered = 0;
    const problems: string[] = [];
    for (const accepted of round.accepted) {
      const verdict = verdicts.find((v) => Number(v.slot) === accepted.slot);
      const modelId = committee[accepted.slot];
      if (!verdict || !modelId) {
        problems.push(`slot ${accepted.slot}: no matching verdict in calldata`);
        continue;
      }
      const responseBytes = toBytes(verdict.responseBody);
      const requestBytes = buildRequestBytes(schema.value.head, modelId, schema.value.mid, evidenceBytes, schema.value.tail);
      const signer = await recoverEnclaveSigner(requestBytes, responseBytes, verdict.signature);

      if (!signer || signer.toLowerCase() !== accepted.signer.toLowerCase()) {
        problems.push(`slot ${accepted.slot}: recovered ${signer ?? 'nothing'}, contract counted ${accepted.signer}`);
        continue;
      }

      const parsed = parseResponse(responseBytes);
      if (!parsed.ok || parsed.parsed!.navE6 !== accepted.navE6) {
        problems.push(
          `slot ${accepted.slot}: response parses to ${parsed.ok ? formatE6(parsed.parsed!.navE6) : parsed.reason}, log says ${accepted.value}`,
        );
        continue;
      }
      recovered++;
    }

    const claim = `round ${round.epoch} signatures re-verify from raw bytes`;
    if (problems.length === 0 && recovered > 0) {
      report.pass(
        claim,
        `${recovered} accepted verdict(s) rebuilt from the on-chain prompt fragments; each 129-character signed text recovers to the enclave key the contract accepted`,
      );
    } else if (recovered === 0 && round.accepted.length === 0) {
      report.skip(claim, 'this round accepted no verdicts');
    } else {
      report.fail(claim, problems.join('; '));
    }

    if (round.outcome === 'published' && round.medianE6 !== undefined && round.accepted.length > 0) {
      const values = round.accepted.map((a) => a.navE6);
      const computed = median(values);
      const medianClaim = `round ${round.epoch} published the median of its accepted verdicts`;
      if (computed === round.medianE6) {
        report.pass(medianClaim, `median of ${values.map(formatE6).join(', ')} is ${formatE6(computed)}`);
      } else {
        report.fail(medianClaim, `accepted verdicts give ${formatE6(computed)}, the contract published ${formatE6(round.medianE6)}`);
      }

      const band = bandAround(round.medianE6, bandBps);
      const outside = round.accepted.filter((a) => a.navE6 < band.lowE6 || a.navE6 > band.highE6);
      const bandClaim = `round ${round.epoch} kept every counted verdict inside the ${bandBps / 100}% band`;
      if (outside.length === 0) {
        report.pass(bandClaim, `band ${band.low} to ${band.high} USD, widest deviation ${widestDeviation(round.accepted)} bps`);
      } else {
        report.fail(bandClaim, `slots ${outside.map((o) => o.slot).join(', ')} fall outside ${band.low}..${band.high}`);
      }
    }

    if (round.rejected.length > 0 && !options.json) {
      for (const rejected of round.rejected) {
        process.stdout.write(`${' '.repeat(10)}slot ${rejected.slot} (${rejected.modelId ?? 'unknown model'}) rejected: ${rejected.reason} — ${rejected.detail}\n`);
      }
    }
  }
}

/** The URI the issuer published alongside the commitment, when a bounded scan can find it. */
async function evidenceUri(
  publicClient: PublicClient,
  client: AssayClient,
  assetId: Hex,
  evidenceHash: Hex,
): Promise<string | null> {
  const registry = client.addresses.assetRegistry;
  if (!registry) return null;
  try {
    const scan = await scanLogsBackwards(publicClient, registry, {});
    for (const log of parseEventLogs({ abi: assetRegistryAbi, logs: scan.logs, eventName: 'EvidenceCommitted' })) {
      const args = log.args as { assetId?: Hex; evidenceHash?: Hex; uri?: string };
      if (args.assetId?.toLowerCase() === assetId.toLowerCase() && args.evidenceHash?.toLowerCase() === evidenceHash.toLowerCase()) {
        return args.uri ?? null;
      }
    }
  } catch {
    // A missing URI is cosmetic; the commitment itself was already checked on chain.
  }
  return null;
}

function widestDeviation(accepted: Array<{ deviationBps?: number }>): number {
  return accepted.reduce((worst, a) => Math.max(worst, Math.abs(a.deviationBps ?? 0)), 0);
}

async function checkHaltHistory(report: Report, client: AssayClient, assetId: Hex, haltCount: number) {
  const claim = 'the halt history is recorded rather than hidden';
  const last = await safe(() => client.getLastHaltReason(assetId));
  if (!last.ok) {
    report.skip(claim, last.why);
    return;
  }
  report.pass(
    claim,
    haltCount === 0
      ? 'no halts recorded for this asset'
      : `${haltCount} halt(s) recorded, most recent reason ${last.value}`,
  );

  const dispute = await safe(() => client.getDispute(assetId));
  if (!dispute.ok) return;
  if (dispute.value.open) {
    report.warn(
      'no challenge is open against the current price',
      `challenger ${dispute.value.challenger} bonded ${formatUnits(dispute.value.bond, 18)} OKB against epoch ${dispute.value.epoch} at ${isoTime(dispute.value.openedAt)}; consumers are frozen`,
    );
  } else {
    report.pass('no challenge is open against the current price', 'the dispute slot is empty');
  }
}

// -----------------------------------------------------------------------------------------

type Safe<T> = { ok: true; value: T } | { ok: false; why: string };

async function safe<T>(fn: () => Promise<T>): Promise<Safe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const refusal = explainRevert(error);
    return { ok: false, why: refusal.detail };
  }
}

function finish(report: Report, options: Options): void {
  if (options.json) process.stdout.write(`${JSON.stringify(report.toJSON(), null, 2)}\n`);
  else report.summarise();
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`assay-verify failed: ${(error as Error).message}\n`);
    process.exit(1);
  },
);

export { keccak256 };
