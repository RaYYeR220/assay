/**
 * Records the live trust root of a deployment into `web/data/attestation.<chainId>.json`.
 *
 * The dashboard is a static export with no server, so the registered enclave keys have to be
 * baked in at build time for a reader who arrives with no wallet. What is baked in here is not
 * an illustration: every field is read out of the registry on the named chain, and every key
 * carries the transaction in which its Intel TDX quote was verified. The attestation view
 * refreshes these same fields from the chain when it loads, so a key revoked after this
 * snapshot was taken shows as revoked.
 *
 * X Layer caps `eth_getLogs` at a hundred blocks, so the registration events are found by
 * scanning forward from the deployment's `startBlock` rather than backwards from head.
 *
 *   node scripts/snapshot-attestation.mjs [chainId]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  http,
  decodeFunctionData,
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
  'event SignerAttested(address indexed signer, bytes32 indexed measurement, bytes32 indexed modelIdHash, uint8 tcbStatus)',
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
const assetRegistryAbi = parseAbi(['function committee(bytes32 assetId) view returns (string[])']);

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

  const batches = await pooled(windows, ([fromBlock, toBlock]) =>
    client
      .getLogs({ address: d.attestationRegistry, fromBlock, toBlock })
      .catch(() => []),
  );
  const raw = batches.flat();

  const attested = [];
  const allowedImages = [];
  const SIGNER_ATTESTED = keccak256(toHex('SignerAttested(address,bytes32,bytes32,uint8)'));
  const IMAGE_ALLOWED = keccak256(toHex('ImageAllowed(bytes32,bool)'));
  for (const log of raw) {
    const [topic] = log.topics;
    if (topic === SIGNER_ATTESTED) attested.push(log);
    else if (topic === IMAGE_ALLOWED) allowedImages.push(log);
  }

  console.log(`  ${attested.length} SignerAttested, ${allowedImages.length} ImageAllowed`);

  // Registrations, in the order the chain recorded them.
  const registrations = await pooled(attested, async (log) => {
    const tx = await client.getTransaction({ hash: log.transactionHash });
    let modelId = null;
    let quoteBytes = null;
    let rawQuote = null;
    try {
      const { args } = decodeFunctionData({ abi: registryAbi, data: tx.input });
      rawQuote = args[0];
      modelId = args[1];
      quoteBytes = (rawQuote.length - 2) / 2;
    } catch {
      /* registered through some other entry point; the event still stands on its own */
    }
    return {
      signer: getAddress(`0x${log.topics[1].slice(26)}`),
      measurement: log.topics[2],
      modelIdHash: log.topics[3],
      tcbStatus: Number(BigInt(log.data)),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber.toString(),
      modelId,
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

  let committee = [];
  try {
    committee = await client.readContract({
      address: d.assetRegistry,
      abi: assetRegistryAbi,
      functionName: 'committee',
      args: [d.assetId],
    });
  } catch {
    /* the asset may not be registered yet */
  }

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
