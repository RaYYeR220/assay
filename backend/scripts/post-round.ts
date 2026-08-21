/**
 * post-round.ts — commit the evidence, run a live committee round, and post it on chain.
 *
 *   node --experimental-strip-types scripts/post-round.ts <assetId> [--skip-commit] [--dry]
 *
 * Order matters and is deliberate:
 *   1. commitEvidence FIRST, from the issuer, and WAIT for it to confirm. Receipts live one
 *      hour in gateway memory, so the commit must not sit inside that window — a commit that
 *      lands slowly would eat the budget for the signatures we are about to buy.
 *   2. Then run the committee and fetch every signature immediately.
 *   3. Then postAppraisal, promptly.
 *
 * Writes the recorded bundle with the `onChain` overlay the dashboard replays, so the judge
 * path works with zero credentials.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, defineChain,
  decodeEventLog, type Hex, type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { appraise, persistBundle, type AppraisalBundle } from '../src/appraise.ts';
import { buildEvidence, loadAsset } from '../src/evidence.ts';
import { REJECT_REASONS } from '../src/canonical.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DATA = join(HERE, '..', 'data');

// --- config -----------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(ROOT, 'deployments', '1952.json'), 'utf8')) as {
  assayOracle: Address; assetRegistry: Address; assetId: Hex; chainId: number; explorer: string;
};

const xlayerTestnet = defineChain({
  id: manifest.chainId,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ASSAY_RPC_URL ?? 'https://testrpc.xlayer.tech'] } },
});

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const p = join(ROOT, '..', 'internal', '.env');
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'));
    if (m?.[1]?.trim()) return m[1].trim();
  }
  throw new Error(`${name} not set (env or internal/.env)`);
}

const oracleAbi = JSON.parse(readFileSync(join(ROOT, 'out', 'AssayOracle.sol', 'AssayOracle.json'), 'utf8')).abi;
const registryAbi = JSON.parse(readFileSync(join(ROOT, 'out', 'AssetRegistry.sol', 'AssetRegistry.json'), 'utf8')).abi;

const argv = process.argv.slice(2);
const assetIdArg = argv.find((a) => !a.startsWith('--'));
const SKIP_COMMIT = argv.includes('--skip-commit');
const DRY = argv.includes('--dry');

// --- helpers ----------------------------------------------------------------

const explorerTx = (h: string) => `${manifest.explorer}/tx/${h}`;
const usd = (e6: bigint | string | null) => (e6 === null ? '—' : `$${(Number(e6) / 1e6).toFixed(6)}`);

function jsonSafe(o: unknown): string {
  return JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + String.fromCharCode(10);
}

const HALT_REASONS = ['None', 'Quorum', 'Band', 'Stale', 'Confidence', 'Disputed', 'SequencerDown'];

async function main() {
  if (!assetIdArg) throw new Error('usage: post-round.ts <assetId> [--skip-commit] [--dry]');

  const asset = loadAsset(assetIdArg);
  const ev = buildEvidence(asset);
  const evidenceHash = `0x${ev.evidenceSha256}` as Hex;
  const evidenceBytes = `0x${Buffer.from(ev.line, 'utf8').toString('hex')}` as Hex;
  // The registered on-chain asset, NOT a locally derived id. The contract keys everything
  // off this, and inventing our own would simply not resolve.
  const onChainAssetId = manifest.assetId;

  const account = privateKeyToAccount(env('DEPLOYER_PK') as Hex);
  const pub = createPublicClient({ chain: xlayerTestnet, transport: http() });
  const wallet = createWalletClient({ account, chain: xlayerTestnet, transport: http() });

  console.log(`asset        ${asset.assetId}  (case ${asset.caseId ?? '-'})`);
  console.log(`onChain id   ${onChainAssetId}`);
  console.log(`evidence     ${ev.byteLength} bytes  sha256=${ev.evidenceSha256}`);
  console.log(`issuer       ${account.address}`);
  console.log(`oracle       ${manifest.assayOracle}`);
  console.log('');

  // --- 1. commit the evidence, and WAIT ------------------------------------
  let commitTx: string | null = null;
  let alreadyCommitted = (await pub.readContract({
    address: manifest.assetRegistry, abi: registryAbi,
    functionName: 'evidenceAllowed', args: [onChainAssetId, evidenceHash],
  })) as boolean;

  console.log(`evidence committed already: ${alreadyCommitted}`);
  if (!alreadyCommitted && !SKIP_COMMIT && !DRY) {
    console.log('committing evidence (must confirm BEFORE we buy signatures)...');
    commitTx = await wallet.writeContract({
      address: manifest.assetRegistry, abi: registryAbi,
      functionName: 'commitEvidence', args: [onChainAssetId, evidenceHash, '', true],
    });
    const rc = await pub.waitForTransactionReceipt({ hash: commitTx as Hex });
    console.log(`  commit tx ${commitTx}  block ${rc.blockNumber}  ${rc.status}`);
    console.log(`  ${explorerTx(commitTx)}`);
    if (rc.status !== 'success') throw new Error('commitEvidence reverted');

    // A confirmed receipt is not the same as a VISIBLE state change. testrpc.xlayer.tech is
    // load balanced, so the very next eth_call can land on a node a block behind and report
    // the evidence as uncommitted. Poll until the commitment is actually readable, otherwise
    // the preflight disagrees with the chain and every recorded bundle misreports its slots.
    alreadyCommitted = false;
    for (let i = 0; i < 15 && !alreadyCommitted; i++) {
      alreadyCommitted = (await pub.readContract({
        address: manifest.assetRegistry, abi: registryAbi,
        functionName: 'evidenceAllowed', args: [onChainAssetId, evidenceHash],
      })) as boolean;
      if (!alreadyCommitted) await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`  commitment readable: ${alreadyCommitted}`);
  }
  if (!alreadyCommitted && !DRY) throw new Error('evidence is not committed — postAppraisal would revert');

  // --- 2. run the committee, fetching signatures immediately ---------------
  console.log('\nrunning the committee (receipts expire in 1h, in memory only)...');
  const t0 = Date.now();
  const bundle: AppraisalBundle = await appraise(asset.assetId, {
    apiKey: env('REDPILL_API_KEY'),
    quorum: 3,
    bandBps: 1500,
    maxAgeSec: 3600,
    persist: false,
    // Precheck against the REGISTERED id, or the local preflight disagrees with the chain.
    onChainAssetId: onChainAssetId,
  });
  const appraiseMs = Date.now() - t0;

  for (const s of bundle.slots) {
    const pf = s.preflight;
    console.log(
      `  slot ${s.slot} ${s.model.padEnd(34)} ${String(s.latencyMs).padStart(6)}ms ` +
        `${pf?.ok ? 'ACCEPT' : 'REJECT'} ${String(pf?.reason ?? '-').padEnd(13)} ` +
        `nav=${usd(pf?.navE6 ?? null).padStart(14)} conf=${pf?.confBps ?? '—'} ${s.failure ?? ''}`,
    );
  }
  console.log(`  local: accepted ${bundle.summary.preflightOk}/5  median=${usd(bundle.summary.medianE6)}  maxDev=${bundle.summary.maxDeviationBps}bps`);
  console.log(`  wouldHalt=${bundle.summary.wouldHalt}  ${bundle.summary.haltReasons.join(' | ')}`);

  if (DRY) {
    console.log('\n--dry: not posting');
    writeFileSync(join(DATA, `dry-${asset.assetId}.json`), jsonSafe(bundle));
    return;
  }

  // --- 3. post, promptly ---------------------------------------------------
  const verdicts = bundle.submission.verdicts.map((v) => ({
    slot: v.slot,
    responseBody: v.responseBody,
    signature: v.signature,
  }));

  console.log('\nposting...');
  let txHash: Hex;
  try {
    const { request } = await pub.simulateContract({
      account,
      address: manifest.assayOracle, abi: oracleAbi,
      functionName: 'postAppraisal', args: [onChainAssetId, evidenceBytes, verdicts],
    });
    txHash = await wallet.writeContract(request);
  } catch (e) {
    console.error(`SIMULATION FAILED: ${(e as Error).message.slice(0, 600)}`);
    writeFileSync(join(DATA, `failed-${asset.assetId}.json`), jsonSafe({ bundle, error: (e as Error).message }));
    throw e;
  }

  const rc = await pub.waitForTransactionReceipt({ hash: txHash });
  const postedAtMs = Date.now();
  console.log(`  tx ${txHash}`);
  console.log(`  block ${rc.blockNumber}  status ${rc.status}  gas ${rc.gasUsed}`);
  console.log(`  ${explorerTx(txHash)}`);

  // --- decode what the chain actually decided ------------------------------
  let published = false;
  let epoch: number | null = null;
  let navE6: string | null = null;
  let haltReason: string | null = null;
  let accepted = 0;
  let distinctSigners = 0;
  let observedAt: number | null = null;
  const slotEvents: { slot: number; accepted: boolean; signer: string; navE6?: string; confidenceBps?: number; createdAt?: number; reason?: string }[] = [];

  for (const log of rc.logs) {
    let d: { eventName: string; args: Record<string, unknown> };
    try {
      d = decodeEventLog({ abi: oracleAbi, data: log.data, topics: log.topics }) as typeof d;
    } catch { continue; }
    const a = d.args;
    if (d.eventName === 'AppraisalPosted') {
      published = true;
      epoch = Number(a.epoch); navE6 = String(a.valueE6);
      accepted = Number(a.accepted); distinctSigners = Number(a.distinctSigners);
      observedAt = Number(a.observedAt);
    } else if (d.eventName === 'Halted') {
      epoch = Number(a.epoch); accepted = Number(a.accepted);
      haltReason = HALT_REASONS[Number(a.reason)] ?? `reason#${a.reason}`;
    } else if (d.eventName === 'RoundIgnored') {
      epoch = Number(a.epoch);
      haltReason = `RoundIgnored(authenticated=${a.authenticated})`;
    } else if (d.eventName === 'VerdictAccepted') {
      slotEvents.push({
        slot: Number(a.slot), accepted: true, signer: String(a.signer),
        navE6: String(a.navE6), confidenceBps: Number(a.confidenceBps), createdAt: Number(a.createdAt),
      });
    } else if (d.eventName === 'VerdictRejected') {
      slotEvents.push({
        slot: Number(a.slot), accepted: false, signer: String(a.signer),
        reason: REJECT_REASONS[Number(a.reason)] ?? `reason#${a.reason}`,
      });
    }
  }
  slotEvents.sort((x, y) => x.slot - y.slot);

  console.log('');
  if (published) {
    console.log(`  PUBLISHED  epoch ${epoch}  nav=${usd(navE6)}  accepted ${accepted}/5  distinctSigners ${distinctSigners}`);
  } else {
    console.log(`  NOT PUBLISHED  epoch ${epoch}  ${haltReason ?? 'no event decoded'}  accepted ${accepted}/5`);
  }
  for (const s of slotEvents) {
    console.log(`    slot ${s.slot} ${s.accepted ? `ACCEPTED nav=${usd(s.navE6!)} conf=${s.confidenceBps}` : `REJECTED ${s.reason}`}  ${s.signer}`);
  }

  // --- 4. record the bundle with the onChain overlay -----------------------
  const enriched = {
    ...bundle,
    onChain: {
      chainId: manifest.chainId,
      explorer: manifest.explorer,
      oracle: manifest.assayOracle,
      assetId: onChainAssetId,
      epoch,
      txHash,
      txUrl: explorerTx(txHash),
      blockNumber: Number(rc.blockNumber),
      gasUsed: Number(rc.gasUsed),
      published,
      navE6,
      haltReason,
      accepted,
      distinctSigners,
      observedAt,
      evidenceHash,
      slots: slotEvents,
      evidenceCommitment: {
        committed: true,
        evidenceHash,
        txHash: commitTx,
        txUrl: commitTx ? explorerTx(commitTx) : null,
        registry: manifest.assetRegistry,
        preCommitted: commitTx === null,
      },
    },
    timing: {
      appraiseMs,
      // The operational number: first completion -> posted transaction. The receipt TTL
      // budget is 3600s measured from EACH slot's own completion, so the binding constraint
      // is the slowest slot, not the round.
      firstCompletionToPostedMs: postedAtMs - t0,
      slowestSlotMs: Math.max(...bundle.slots.map((s) => s.latencyMs)),
      receiptTtlSec: 3600,
    },
  };
  mkdirSync(join(DATA, 'bundles'), { recursive: true });
  persistBundle(enriched as AppraisalBundle);
  writeFileSync(join(DATA, 'bundles', `${asset.assetId}-latest.json`), jsonSafe(enriched));

  console.log(`\n  timing: appraise ${appraiseMs}ms, first completion -> posted ${enriched.timing.firstCompletionToPostedMs}ms`);
  console.log(`  wrote data/bundles/${asset.assetId}-latest.json`);
  console.log(`\nTX: ${txHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
