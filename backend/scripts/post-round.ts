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

import { appraise, type AppraisalBundle } from '../src/appraise.ts';
import { buildEvidence, loadAsset } from '../src/evidence.ts';
import { REJECT_REASONS, SCHEMA_ID } from '../src/canonical.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DATA = join(HERE, '..', 'data');

// --- config -----------------------------------------------------------------

const argv0 = process.argv.slice(2);
const ci = argv0.indexOf('--chain');
const CHAIN_ID = ci >= 0 ? Number(argv0[ci + 1]) : 1952;

/**
 * Per-chain deployment. Mainnet and testnet reuse the same addresses in different roles, so
 * these are kept explicit rather than derived — a swapped oracle/registry pair would sail
 * through type checking and revert on chain.
 */
const CHAINS: Record<number, {
  name: string; rpc: string; explorer: string;
  assayOracle: Address; assetRegistry: Address;
}> = {
  1952: {
    name: 'X Layer Testnet',
    rpc: 'https://testrpc.xlayer.tech',
    explorer: 'https://web3.okx.com/explorer/x-layer-testnet',
    assayOracle: '0xEd888DC5b67038fF66D9a5DeB76B323655f21b23',
    assetRegistry: '0xE6FBd750cf852149185c226c770B6d484398a71F',
  },
  196: {
    name: 'X Layer Mainnet',
    rpc: 'https://rpc.xlayer.tech',
    explorer: 'https://www.oklink.com/xlayer',
    assayOracle: '0xE6FBd750cf852149185c226c770B6d484398a71F',
    assetRegistry: '0x1f2E8DA086fF0919C3efbf3D952a65a820D857a4',
  },
};

const CHAIN = CHAINS[CHAIN_ID]!;
if (!CHAINS[CHAIN_ID]) throw new Error(`unknown chain ${CHAIN_ID} (expected 196 or 1952)`);

/** The default listing: the liquid asset, tolerant band, corrected committee. */
const LIQUID = {
  assetKey: 'assay.carbon.liquid.v1',
  assetId: '0x65e8b0665d0465ee6e0bbbff780354ea5a389bab5b30f737faf0ce7e1d1f4584' as Hex,
  committee: [
    'deepseek/deepseek-v4-flash-0731',
    'google/gemma-3-27b-it',
    'meta-llama/llama-3.3-70b-instruct',
    'qwen/qwen-2.5-7b-instruct',
    'qwen/qwen3-vl-30b-a3b-instruct',
  ],
};

const manifest = {
  chainId: CHAIN_ID,
  explorer: CHAIN.explorer,
  assayOracle: CHAIN.assayOracle,
  assetRegistry: CHAIN.assetRegistry,
  assetId: LIQUID.assetId,
  assetIdV2: LIQUID.assetId,
  assetKeyV2: LIQUID.assetKey,
};

const chainDef = defineChain({
  id: CHAIN_ID,
  name: CHAIN.name,
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ASSAY_RPC_URL ?? CHAIN.rpc] } },
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
  //
  // Schemas are content-addressed and immutable, so a prompt change means a NEW listing
  // rather than an edit. Default to the newest listing; `--asset-id` pins an older one so a
  // historical round can still be reproduced against the exact question that produced it.
  const mi = argv.indexOf('--models');
  const committee = mi >= 0 ? argv[mi + 1]!.split(',') : LIQUID.committee;
  const idOverride = argv[argv.indexOf('--asset-id') + 1];
  const onChainAssetId = (argv.includes('--asset-id') && idOverride
    ? idOverride
    : manifest.assetIdV2 ?? manifest.assetId) as Hex;

  const account = privateKeyToAccount(env('DEPLOYER_PK') as Hex);
  const pub = createPublicClient({ chain: chainDef, transport: http() });
  const wallet = createWalletClient({ account, chain: chainDef, transport: http() });

  console.log(`asset        ${asset.assetId}  (case ${asset.caseId ?? '-'})`);
  console.log(`onChain id   ${onChainAssetId}${onChainAssetId === manifest.assetIdV2 ? `  (${manifest.assetKeyV2})` : ''}`);
  console.log(`schemaId     ${SCHEMA_ID}`);
  console.log(`evidence     ${ev.byteLength} bytes  sha256=${ev.evidenceSha256}`);
  console.log(`chain        ${CHAIN.name} (${CHAIN_ID})`);
  console.log(`issuer       ${account.address}`);
  console.log(`committee    ${committee.map((m, i) => `${i}:${m.split('/')[1]}`).join(' ')}`);
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

  // Policy comes from the REGISTRY, never from local defaults. The issuer sets quorum,
  // band and the confidence floor on chain; guessing them locally makes the preflight
  // disagree with the contract and every recorded bundle misreport its own outcome.
  const cfg = (await pub.readContract({
    address: manifest.assetRegistry, abi: registryAbi,
    functionName: 'config', args: [onChainAssetId],
  })) as { quorum: number; bandBps: number; minConfidenceBps: number; maxAgeSec: number; schemaId: Hex; active: boolean };

  console.log(`policy (on chain)  quorum=${cfg.quorum} band=${cfg.bandBps}bps minConfidence=${cfg.minConfidenceBps}bps maxAge=${cfg.maxAgeSec}s`);
  if (cfg.schemaId !== SCHEMA_ID) {
    throw new Error(`schema mismatch: registry ${cfg.schemaId} vs backend ${SCHEMA_ID} — every signature would fail`);
  }
  if (!cfg.active) throw new Error('asset is not active');

  // --- 2. run the committee, fetching signatures immediately ---------------
  console.log('\nrunning the committee (receipts expire in 1h, in memory only)...');
  const t0 = Date.now();
  const bundle: AppraisalBundle = await appraise(asset.assetId, {
    apiKey: env('REDPILL_API_KEY'),
    quorum: Number(cfg.quorum),
    bandBps: Number(cfg.bandBps),
    minConfidenceBps: Number(cfg.minConfidenceBps),
    maxAgeSec: Number(cfg.maxAgeSec),
    persist: false,
    // Precheck against the REGISTERED id, or the local preflight disagrees with the chain.
    onChainAssetId: onChainAssetId,
    // The listing's committee, not whatever Deploy.s.sol last held. Slot order is
    // consensus-critical and this listing corrected slot 3.
    models: committee,
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
      policy: {
        quorum: Number(cfg.quorum), bandBps: Number(cfg.bandBps),
        minConfidenceBps: Number(cfg.minConfidenceBps), maxAgeSec: Number(cfg.maxAgeSec),
        schemaId: cfg.schemaId,
      },
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
  // Chain-scoped, so a mainnet round never silently overwrites the testnet one.
  writeFileSync(join(DATA, 'bundles', `${asset.assetId}-${CHAIN_ID}-${bundle.createdAt.replace(/[:.]/g, '-')}.json`), jsonSafe(enriched));
  writeFileSync(join(DATA, 'bundles', `${asset.assetId}-${CHAIN_ID}-latest.json`), jsonSafe(enriched));
  if (CHAIN_ID === 1952) writeFileSync(join(DATA, 'bundles', `${asset.assetId}-latest.json`), jsonSafe(enriched));

  console.log(`\n  timing: appraise ${appraiseMs}ms, first completion -> posted ${enriched.timing.firstCompletionToPostedMs}ms`);
  console.log(`  wrote data/bundles/${asset.assetId}-latest.json`);
  console.log(`\nTX: ${txHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
