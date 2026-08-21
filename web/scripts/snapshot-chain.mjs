/**
 * Records what a deployment currently says about itself into `web/data/`: the trust root, as
 * `attestation.<chainId>.json`, and the policy a round is judged against, as
 * `policy.<chainId>.json`.
 *
 * The dashboard is a static export with no server, so both have to be baked in at build time
 * for a reader who arrives with no wallet. What is baked in here is not an illustration: every
 * field is read out of the contracts on the named chain, and every key carries the transaction
 * in which its Intel TDX quote was verified. The attestation view refreshes these same fields
 * from the chain when it loads, so a key revoked after this snapshot was taken shows as revoked.
 *
 * X Layer caps `eth_getLogs` at a hundred blocks, so the registration events are found by
 * scanning forward from the deployment's `startBlock` rather than backwards from head.
 *
 *   node scripts/snapshot-chain.mjs [chainId]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  http,
  decodeFunctionData,
  decodeEventLog,
  getAddress,
  keccak256,
  toHex,
  parseAbi,
} from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'data');

const RPC = {
  196: 'https://rpc.xlayer.tech',
  1952: 'https://testrpc.xlayer.tech',
};

/** X Layer refuses a wider window. */
const LOG_WINDOW = 100n;
const CONCURRENCY = 12;

const registryAbi = parseAbi([
  'event SignerAttested(address indexed signer, bytes32 indexed measurement, bytes32 indexed modelIdHash, string modelId, uint8 tcbStatus)',
  'event ImageAllowed(bytes32 indexed measurement, bool allowed)',
  'function registerSigner(bytes rawQuote, string modelId) returns (address)',
  'function signerInfo(address signer) view returns ((bytes32 measurement, uint64 attestedAt, uint8 tcbStatus, bool revoked, bool known))',
  'function servesModel(address signer, bytes32 modelIdHash) view returns (bool)',
  'function adapter() view returns (address)',
  'function attestationTtl() view returns (uint64)',
  'function signerOffset() view returns (uint8)',
  'function allowedImage(bytes32 measurement) view returns (bool)',
]);

const adapterAbi = parseAbi(['function isTrusted() view returns (bool)']);
const assetRegistryAbi = parseAbi([
  'function committee(bytes32 assetId) view returns (string[])',
  'function config(bytes32 assetId) view returns ((address issuer, uint8 quorum, uint8 minDistinctSigners, uint16 bandBps, uint16 minConfidenceBps, uint32 maxAgeSec, uint16 disputeBandBps, uint96 disputeBond, bytes32 schemaId, bool active))',
  'function metadataURI(bytes32 assetId) view returns (string)',
]);

const TCB = [
  'UpToDate',
  'OutOfDate',
  'SWHardeningNeeded',
  'ConfigurationNeeded',
  'ConfigurationAndSWHardeningNeeded',
  'OutOfDateConfigurationNeeded',
  'Revoked',
];

/**
 * Report data sits in the last 64 bytes of the TD report body of a v4 TDX quote, which follows
 * a 48-byte header. It is only reported when the bytes actually carry the signer the registry
 * derived, so a quote in a layout this does not understand yields nothing rather than a guess.
 */
function reportDataFrom(rawQuote, signer, offset) {
  const body = rawQuote.startsWith('0x') ? rawQuote.slice(2) : rawQuote;
  const start = (48 + 584 - 64) * 2;
  const data = body.slice(start, start + 128);
  if (data.length !== 128) return null;
  const embedded = data.slice(offset * 2, offset * 2 + 40).toLowerCase();
  return embedded === signer.slice(2).toLowerCase() ? data : null;
}

async function pooled(items, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

async function main() {
  const chainId = Number(process.argv[2] ?? 1952);
  const manifestPath = join(ROOT, 'deployments', `${chainId}.json`);
  if (!existsSync(manifestPath)) {
    console.error(`no deployments/${chainId}.json — nothing to snapshot`);
    process.exit(1);
  }
  const d = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const url = RPC[chainId];
  if (!url) throw new Error(`no RPC configured for chain ${chainId}`);

  const client = createPublicClient({ transport: http(url, { retryCount: 3, timeout: 20_000 }) });
  const head = await client.getBlockNumber();
  const start = BigInt(d.startBlock ?? 0);
  console.log(`chain ${chainId}: scanning ${start} → ${head} for registrations`);

  const windows = [];
  for (let from = start; from <= head; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n > head ? head : from + LOG_WINDOW - 1n;
    windows.push([from, to]);
  }

  // A window that will not answer is not an empty window. Swallowing the difference would
  // write a snapshot claiming the registry holds no keys, which is a far worse lie than
  // failing, so every window is retried and the run aborts rather than under-report.
  const batches = await pooled(windows, async ([fromBlock, toBlock]) => {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await client.getLogs({ address: d.attestationRegistry, fromBlock, toBlock });
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw new Error(
      `eth_getLogs failed for blocks ${fromBlock}–${toBlock}: ${lastError?.shortMessage ?? lastError?.message}`,
    );
  });
  const raw = batches.flat();

  const attested = [];
  const allowedImages = [];
  const SIGNER_ATTESTED = keccak256(toHex('SignerAttested(address,bytes32,bytes32,string,uint8)'));
  const IMAGE_ALLOWED = keccak256(toHex('ImageAllowed(bytes32,bool)'));
  for (const log of raw) {
    const [topic] = log.topics;
    if (topic === SIGNER_ATTESTED) attested.push(log);
    else if (topic === IMAGE_ALLOWED) allowedImages.push(log);
  }

  console.log(`  ${attested.length} SignerAttested, ${allowedImages.length} ImageAllowed`);

  // Registrations, in the order the chain recorded them.
  const registrations = await pooled(attested, async (log) => {
    const { args } = decodeEventLog({
      abi: registryAbi,
      eventName: 'SignerAttested',
      topics: log.topics,
      data: log.data,
    });

    // The quote itself is only in the calldata; the registry keeps its verdict, not its input.
    let quoteBytes = null;
    let rawQuote = null;
    try {
      const tx = await client.getTransaction({ hash: log.transactionHash });
      const decoded = decodeFunctionData({ abi: registryAbi, data: tx.input });
      rawQuote = decoded.args[0];
      quoteBytes = (rawQuote.length - 2) / 2;
    } catch {
      /* registered through some other entry point; the event still stands on its own */
    }

    return {
      signer: getAddress(args.signer),
      measurement: args.measurement,
      modelIdHash: args.modelIdHash,
      modelId: args.modelId,
      tcbStatus: Number(args.tcbStatus),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber.toString(),
      quoteBytes,
      rawQuote,
    };
  });

  const [adapterAddress, ttl, signerOffset, block] = await Promise.all([
    client.readContract({ address: d.attestationRegistry, abi: registryAbi, functionName: 'adapter' }),
    client.readContract({ address: d.attestationRegistry, abi: registryAbi, functionName: 'attestationTtl' }),
    client.readContract({ address: d.attestationRegistry, abi: registryAbi, functionName: 'signerOffset' }),
    client.getBlock(),
  ]);

  let isTrusted = null;
  try {
    isTrusted = await client.readContract({
      address: adapterAddress,
      abi: adapterAbi,
      functionName: 'isTrusted',
    });
  } catch {
    isTrusted = null;
  }

  /**
   * Every asset this deployment is known to appraise: the ones the manifest names, plus any a
   * recorded round was run against. A round is judged by its own asset's policy, so reading one
   * asset's band and applying it to another would misstate why a round refused.
   */
  const bundleDir = join(ROOT, 'backend', 'data', 'bundles');
  // Every `assetId*` the manifest carries, whatever it is called. The deploy script adds assets
  // over time, and each one needs its own policy read, so they are discovered rather than listed.
  const assetIds = new Set(
    Object.entries(d)
      .filter(([k, v]) => /^assetId/.test(k) && typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v))
      .map(([, v]) => v),
  );
  const bundleFiles = existsSync(bundleDir)
    ? readdirSync(bundleDir).filter((f) => f.endsWith('.json'))
    : [];
  const parsedBundles = [];
  for (const file of bundleFiles) {
    try {
      parsedBundles.push(JSON.parse(readFileSync(join(bundleDir, file), 'utf8')));
    } catch {
      /* a round still being written is picked up on the next run */
    }
  }
  for (const b of parsedBundles) {
    if (b.onChain && Number(b.onChain.chainId) !== chainId) continue;
    const id = b.assetIdHex ?? b.assetIdHash ?? b.onChain?.assetId;
    if (typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id)) assetIds.add(id);
  }

  const assets = {};
  let committee = [];
  for (const assetId of assetIds) {
    try {
      const [seats, cfg, uri] = await Promise.all([
        client.readContract({
          address: d.assetRegistry,
          abi: assetRegistryAbi,
          functionName: 'committee',
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
          functionName: 'metadataURI',
          args: [assetId],
        }),
      ]);
      if (!cfg.active && seats.length === 0) continue;
      if (committee.length === 0) committee = seats;
      assets[assetId] = {
        assetId,
        committee: seats,
        metadataURI: uri,
        issuer: cfg.issuer,
        quorum: Number(cfg.quorum),
        minDistinctSigners: Number(cfg.minDistinctSigners),
        bandBps: Number(cfg.bandBps),
        minConfidenceBps: Number(cfg.minConfidenceBps),
        maxAgeSec: Number(cfg.maxAgeSec),
        disputeBandBps: Number(cfg.disputeBandBps),
        disputeBond: cfg.disputeBond.toString(),
        schemaId: cfg.schemaId,
        active: cfg.active,
      };
    } catch {
      /* not registered on this deployment */
    }
  }
  const policy = Object.keys(assets).length > 0 ? assets : null;

  // Group registrations by the key the quote derived. One enclave may front several models.
  const bySigner = new Map();
  for (const r of registrations) {
    const key = r.signer.toLowerCase();
    if (!bySigner.has(key)) bySigner.set(key, []);
    bySigner.get(key).push(r);
  }

  const modelByHash = new Map();
  for (const m of committee) modelByHash.set(keccak256(toHex(m)), m);
  for (const r of registrations) if (r.modelId) modelByHash.set(r.modelIdHash, r.modelId);

  const signers = [];
  for (const [key, group] of bySigner) {
    const address = group[0].signer;
    const info = await client.readContract({
      address: d.attestationRegistry,
      abi: registryAbi,
      functionName: 'signerInfo',
      args: [address],
    });
    if (!info.known) continue;

    const models = [];
    const seen = new Set();
    for (const r of group) {
      const model = modelByHash.get(r.modelIdHash) ?? r.modelIdHash;
      if (seen.has(model)) continue;
      const serves = await client.readContract({
        address: d.attestationRegistry,
        abi: registryAbi,
        functionName: 'servesModel',
        args: [address, r.modelIdHash],
      });
      if (!serves) continue;
      seen.add(model);
      models.push({
        model,
        modelIdHash: r.modelIdHash,
        txHash: r.txHash,
        blockNumber: r.blockNumber,
        quoteBytes: r.quoteBytes,
      });
    }

    const withQuote = group.find((r) => r.rawQuote);
    const reportData = withQuote
      ? reportDataFrom(withQuote.rawQuote, address, Number(signerOffset))
      : null;

    const imageAllowed = await client.readContract({
      address: d.attestationRegistry,
      abi: registryAbi,
      functionName: 'allowedImage',
      args: [info.measurement],
    });

    signers.push({
      address,
      mrTd: info.measurement,
      tcbStatus: Number(info.tcbStatus),
      tcbStatusLabel: TCB[Number(info.tcbStatus)] ?? `status ${info.tcbStatus}`,
      attestedAt: Number(info.attestedAt),
      revoked: info.revoked,
      imageAllowed,
      models: models.map((m) => m.model),
      registrations: models,
      txHash: models[0]?.txHash ?? group[0].txHash,
      blockNumber: models[0]?.blockNumber ?? group[0].blockNumber,
      quoteBytes: models[0]?.quoteBytes ?? null,
      reportData,
    });
    void key;
  }

  const allowlisted = allowedImages.map((log) => ({
    measurement: log.topics[1],
    allowed: BigInt(log.data) === 1n,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
  }));

  const snapshot = {
    chainId,
    source: 'live',
    capturedAt: Number(block.timestamp),
    capturedAtBlock: block.number.toString(),
    adapter: {
      address: adapterAddress,
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
    committee,
    allowedImages: allowlisted,
    signers,
  };

  mkdirSync(OUT, { recursive: true });
  const dest = join(OUT, `attestation.${chainId}.json`);
  writeFileSync(dest, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `wrote ${dest}: ${signers.length} key(s), ${signers.reduce((n, s) => n + s.models.length, 0)} model registration(s), adapter ${snapshot.adapter.label} isTrusted=${snapshot.adapter.isTrusted}`,
  );

  // Block times for every block a recorded round refers to. `next build` must not need a
  // network, so the timestamps a round is dated by are resolved here and written down; a round
  // recorded after this ran simply has no date until the snapshot is taken again.
  const wanted = new Set();
  const commitTxs = new Set();
  for (const b of parsedBundles) {
    const oc = b.onChain;
    if (!oc || Number(oc.chainId) !== chainId) continue;
    if (oc.blockNumber !== undefined && oc.blockNumber !== null) wanted.add(String(oc.blockNumber));
    if (oc.evidenceCommitment?.txHash) commitTxs.add(oc.evidenceCommitment.txHash);
  }

  const commitBlocks = {};
  for (const [txHash, receipt] of await pooled([...commitTxs], async (h) => [
    h,
    await client.getTransactionReceipt({ hash: h }).catch(() => null),
  ])) {
    if (!receipt) continue;
    commitBlocks[txHash] = receipt.blockNumber.toString();
    wanted.add(receipt.blockNumber.toString());
  }

  const blockTimes = {};
  for (const [number, ts] of await pooled([...wanted], async (n) => [
    n,
    await client
      .getBlock({ blockNumber: BigInt(n) })
      .then((b) => Number(b.timestamp))
      .catch(() => null),
  ])) {
    if (ts !== null) blockTimes[number] = ts;
  }

  if (Object.keys(blockTimes).length > 0 || Object.keys(commitBlocks).length > 0) {
    const blocksDest = join(OUT, `blocks.${chainId}.json`);
    writeFileSync(
      blocksDest,
      `${JSON.stringify({ chainId, timestamps: blockTimes, commitmentBlocks: commitBlocks }, null, 2)}\n`,
    );
    console.log(
      `wrote ${blocksDest}: ${Object.keys(blockTimes).length} block time(s), ${Object.keys(commitBlocks).length} commitment block(s)`,
    );
  }

  if (policy) {
    const policyDest = join(OUT, `policy.${chainId}.json`);
    writeFileSync(
      policyDest,
      `${JSON.stringify(
        { chainId, source: 'live', capturedAt: Number(block.timestamp), assets: policy },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${policyDest}: ${Object.keys(policy).length} asset polic(ies)`);
    for (const a of Object.values(policy)) {
      console.log(
        `    ${a.assetId.slice(0, 12)}… quorum ${a.quorum}, ${a.minDistinctSigners} distinct signer(s), ` +
          `band ${a.bandBps} bps, confidence ${a.minConfidenceBps} bps, max age ${a.maxAgeSec}s, ${a.committee.length} seat(s)`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
