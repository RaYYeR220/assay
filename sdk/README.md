# @assay/sdk

Typed client for **Assay**, a net asset value oracle on OKX X Layer for real-world assets
nobody can price.

Five language models running in Intel TDX enclaves appraise the asset. Each answer is signed
by the enclave key. The contract re-verifies the attestation on chain, rebuilds the exact
request and response bytes, checks the signature, parses the answer strictly, and publishes
a price only if a quorum agrees within a band on fresh evidence. Otherwise it records a HALT
and every consumer is frozen.

Refusing to price is the mechanism, not a failure mode. This package exists so you can
integrate that without reading the Solidity — and so that when the oracle refuses, you get a
sentence instead of a hex blob.

## Install

```bash
pnpm add @assay/sdk viem
```

Node 22 or newer. `viem` is a peer of everything here; no other runtime dependency.

## Quickstart

```ts
import { AssayClient, AssayRefusalError } from '@assay/sdk';

const assay = AssayClient.fromChain({ chainId: 196 });      // reads deployments/196.json
const [carbon] = await assay.listAssets();

try {
  const { value } = await assay.getNav(carbon.assetId);      // requireFreshNav
  console.log(`1 credit = $${value}`);
} catch (error) {
  if (error instanceof AssayRefusalError) {
    console.log(error.refusal.reason);                       // 'halted'
    console.log(error.refusal.detail);                       // 'the committee disagreed beyond the 10% band, ...'
  }
}

const round = await assay.getRound(carbon.assetId, carbon.epoch);
console.log(round.summary);                                  // 'epoch 12: HALT — the surviving answers disagreed ...'
```

## Verify a deployment before you trust it

```bash
npx assay-verify --chain 196
```

One command, no credentials, no wallet. It re-derives every claim the project makes from
public data and prints `PASS`, `FAIL` or `SKIPPED` per claim: contracts deployed and their
bytecode hashes, whether the attestation adapter is the real on-chain Intel DCAP verifier or
the labelled development stand-in, every registered enclave key with its measurement, TCB
status, expiry and the transaction that verified its quote, whether the live enclave still
binds the key the contract registered, and — for each recent round — the request bytes
rebuilt from the on-chain prompt fragments, both bodies hashed, the 129-character signed text
reconstructed and the signer recovered, then checked against what the contract concluded.

It also checks the part that makes a valuation trustworthy rather than merely well-signed:
that the evidence behind each published round was committed by the issuer in advance, and who
committed it.

A check that cannot run prints `SKIPPED` with the reason. It never prints a pass it did not
earn. Exits non-zero if any claim fails.

## API

### Reads

| Function | What it does |
| --- | --- |
| `getNav(assetId)` | The attested unit price in 1e6 USD, or throws `AssayRefusalError` with the decoded reason. |
| `peekNav(assetId)` | Never throws. Returns the stored `Nav`, a `usable` flag, and a `refusal` when it is false. |
| `listAssets()` | Every listed asset with its policy, committee, epoch and halt count. |
| `getAssetConfig(assetId)` | Quorum, band, freshness window, confidence floor, dispute bond, schema. |
| `getCommittee(assetId)` | The seated models, in slot order. The index is the slot. |
| `getSchemaFor(assetId)` | The prompt fragments the contract concatenates, read back from the registry. |
| `getAttestedSigners()` | Registered enclave keys with measurement, TCB status, expiry and verification tx. |
| `getRound(assetId, epoch)` | One round rebuilt from logs: what each seat returned, what was counted, the median, the band, the outcome. |
| `getRecentRounds(assetId, n)` | The last `n` rounds, newest first. |
| `getDispute(assetId)` | The open challenge, if any, and the epoch it contests. |
| `getVault(address?)` | Share price, supply, liquidity, and whether transacting is possible right now. |
| `getObservationWatermark(assetId)` | The newest response timestamp the oracle has already counted. |
| `isEvidenceCommitted(assetId, evidence)` | Whether the issuer committed to this document. Check it before assembling a round. |
| `getPendingWithdrawal(address)` | Bond money credited to an address and waiting to be collected. |
| `getChallengeWindow()` | How long a challenge stands before it can lapse. |

### Refusals

| Function | What it does |
| --- | --- |
| `explainRevert(error, ctx?)` | Turns any caught revert into `{ reason, detail, error, args, isRefusalToPrice }`. Handles every custom error in the protocol, plus `Error(string)`, `Panic`, and transport failures. Pass `{ bandBps, maxAgeSec }` and the detail names the real numbers. |
| `explainRevertData(data)` | Same, when you already hold the revert bytes. |
| `extractRevertData(error)` | Digs the payload out of however viem, ethers or a bare node nested it. |
| `AssayRefusalError` | Thrown by `getNav`; carries `.refusal`. |
| `REJECT_REASON_TEXT` / `HALT_REASON_TEXT` | The `RejectReason` and `HaltReason` enums as sentences. |

### Verification

Mirrors the contract exactly, so you can check a bundle before paying gas.

| Function | What it does |
| --- | --- |
| `buildRequestBytes(head, modelId, mid, evidence, tail)` | The exact bytes an enclave was asked to answer, `head ‖ modelId ‖ mid ‖ evidence ‖ tail`. |
| `signedText(reqBytes, respBytes)` | `sha256hex(req) + ':' + sha256hex(resp)` — 129 ASCII characters. |
| `recoverEnclaveSigner(req, resp, sig)` | EIP-191 personal-sign recovery. Returns `null` on a malformed signature rather than throwing, like the contract. |
| `parseResponse(respBytes)` | The strict parser, returning the same `RejectReason` the contract would. It locates `"content":"ASSAY1\|nav_usd_e6=`, `"finish_reason":"stop"` and `"created":` by scanning the raw bytes, exactly as the contract does. |
| `checkVerdict(input)` | Every check `_checkVerdict` runs, in order, naming the one that failed. |
| `checkBundle(members, schema, evidence, policy)` | A whole round: per-member results, quorum, distinct signers, median, band, and whether it would publish. |
| `packVerdict(slot, body, sig)` | The submittable `Verdict` tuple. An absent seat packs empty, because the contract demands every seat. |
| `isJsonStringSafe(value)` | The evidence charset the contract enforces. |
| `median` / `bandAround` / `formatE6` | The same arithmetic the contract does, in bigint. |

### Writes

Optional. Pass a viem `walletClient` to the constructor. Every write simulates first and
throws `AssayRefusalError` with the decoded reason rather than a failed transaction.

`postAppraisal` · `simulateAppraisal` · `challenge` · `resolveDispute` · `lapseDispute` ·
`subscribe` · `redeem` · `registerAsset` · `registerSchema` · `commitEvidence` ·
`registerSigner` · `withdraw`

Two of these need explaining. `commitEvidence` is not optional: the oracle refuses to price a
document its issuer has not committed to, so a round on uncommitted evidence reverts with
`EvidenceNotCommitted` however good the signatures are. And `registerSigner` is owner-gated —
the signer address still comes out of the on-chain-verified quote and nobody can name it, but a
TDX quote says nothing about which *model* an enclave fronts, so that binding is an explicit
curator assertion rather than an attestation pretending to be one.

Bonds are paid out by credit rather than by transfer, so a challenger that reverts on receive
cannot wedge a dispute resolution. Call `withdraw()` to collect what
`getPendingWithdrawal(address)` reports.

### Chains and deployments

`xLayer` (196, `https://rpc.xlayer.tech`) and `xLayerTestnet` (1952,
`https://testrpc.xlayer.tech`) are exported as viem chains, with explorer links via
`txUrl` / `addressUrl`. `loadDeployment(chainId)` reads `deployments/<chainId>.json`, walking
up from the working directory; `tryLoadDeployment` returns `null` instead of throwing when
the file is not there yet.

## Reading history on X Layer

X Layer's public RPC rejects any `eth_getLogs` spanning more than 100 blocks. Everything in
this package that reads history therefore walks backwards from the head in 100-block windows
and stops as soon as it has what it needs, and every result reports the range it covered — so
"not in the last N blocks" is never dressed up as "does not exist".

Two knobs matter:

- put a `startBlock` in `deployments/<chainId>.json` and scans become exact instead of bounded;
- `lookbackBlocks` (default 20,000) caps how far back an unbounded scan walks.

## On-chain consumers

`solidity/IAssayOracle.sol` is a standalone copy of the consumer interface, structs inlined
so it compiles on its own. See [INTEGRATION.md](./INTEGRATION.md) for the three-line pattern
and, more importantly, for what not to do with the revert.

## Development

```bash
pnpm install
pnpm abi        # regenerate src/abi/* from the Foundry build output
pnpm fixture    # regenerate the signed test bundle
pnpm test
pnpm build
```

The ABIs are generated from `../out` and committed, so the published package needs no
Foundry. `test/enums.test.ts` re-reads `../src/Types.sol` when the contracts are in the tree
and fails if an enum was reordered — Solidity encodes enums by index, and a silent
reordering would make every decoded reason in this package wrong.
