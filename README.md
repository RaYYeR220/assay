# Assay

**A net asset value oracle that refuses to price.**

Assay values real-world assets that no price feed covers by putting a committee of language models
inside trusted execution environments, and then giving the chain the means to check their work. A
price is published only when a quorum of attested enclaves agrees, within a band, on evidence that
is recent and on record. When they do not agree, the oracle publishes nothing and says so on chain,
and every contract downstream stops moving money.

Built on [X Layer](https://web3.okx.com/xlayer), OKX's OP Stack L2.

---

## The problem

Tokenising a treasury bill is a solved problem: it has a price, and an oracle can read it. Almost
nothing else does. A carbon credit batch, a royalty stream, an invoice — these are priced by
appraisal, by someone forming a judgement about evidence. That judgement is exactly the thing a
smart contract cannot verify, which is why long-tail real-world assets end up either unpriceable or
priced by a trusted party with a private spreadsheet.

Carbon credits are the sharpest version of this. There is no single carbon spot price to read.
The exchange-traded avoidance benchmarks have effectively died: the CBL Nature-Based Global
Emissions Offset future went from around $15 in early 2022 to $0.22 on five contracts of daily
volume, the C-GEO contract was permanently delisted on 2 January 2025 with zero open interest,
Climate Impact X cut its Nature X benchmark from daily to monthly publication in May 2026, and ACX
wound down its ADGM exchange. Meanwhile durable removals decoupled upward, with the Puro biochar
index at EUR 129.21 in July 2026. Two credits can differ by two orders of magnitude and no feed
will tell you which one you are holding. Verra publishes no price index at all.

Language models can form that judgement. The obvious thing to do with them, and the thing most
attempts do, is to put a model behind an API and have it post a number. That replaces a trusted
spreadsheet with a trusted API. The chain still has no way to know which model answered, what it was
asked, whether the answer was tampered with in transit, or whether the model was confident, close to
its peers, or hallucinating.

## What Assay does

Assay treats an appraisal as a claim that has to survive verification, and treats the absence of a
verified appraisal as a first-class state rather than an outage.

- **Five different models, answering inside a TEE.** Every committee member runs in a confidential
  environment that signs its own output with a key derived inside the enclave. Which model answered
  is not a label: the contract rebuilds each request with that slot's model identifier before it
  checks the signature, so a verdict cannot be moved between slots. On the deployed committee those
  five models are fronted by a single attested gateway enclave, so they share one signing key.
  `docs/THREAT-MODEL.md` says exactly what that costs and what it does not.
- **The attestation is re-verified on chain.** An Intel TDX quote is checked by a contract on X
  Layer, and the signing address is read *out of the verified quote*. No operator gets to nominate a
  signer; the registry's contents are a consequence of Intel's root of trust.
- **The question is on chain too.** The exact request bytes each model was sent are rebuilt by the
  contract from prompt fragments stored in the registry. A relayer cannot quietly ask a friendlier
  question, because a changed question produces a hash the enclave never signed.
- **Consensus or halt.** A NAV is published only if enough members answered validly, their answers
  fall within the configured agreement band, their responses are fresh, and the sequencer is healthy.
  Any other outcome is a recorded halt.
- **Every failure fails closed.** A truncated generation, a model that returns prose instead of the
  required format, a stale timestamp, a revoked key, a tampered byte — each one is rejected with a
  reason, on chain, and counts against quorum.
- **The price is contestable.** Anyone can post a bond to challenge a published NAV. Consumers stop
  reading it immediately, before anyone adjudicates, and the challenge is settled by a fresh round.

The vault demonstrates what this is for: `subscribe` and `redeem` both price off
`requireFreshNav`, which reverts whenever the oracle will not speak. There is no cached price to
fall back on and no operator override.

---

## The chain of trust

Every link in this chain is checked by a contract on X Layer. Nothing in the middle is trusted.

```
Intel root of trust
        |
        |  TDX quote, verified on chain
        v
AttestationRegistry ------> signer address, read out of report_data
        |                            |
        |                            |  ecrecover
        v                            v
AssetRegistry ---> request bytes ---> sha256 ---.
   (prompt fragments,                            >--- "sha256hex(req):sha256hex(resp)"
    stored on chain)   response bytes ---> sha256 -'          |
                                                              |  EIP-191, secp256k1
                                                              v
                                                   AssayOracle: strict parse,
                                                   quorum, agreement band,
                                                   freshness, sequencer health
                                                              |
                                            .-----------------+-----------------.
                                            v                                   v
                                    NAV published                        HALT recorded
                                            |                                   |
                                            v                                   v
                                   AssayVault mints                    AssayVault reverts
```

An enclave binds its signing address into the `report_data` field of its own TDX quote. The registry
verifies that quote on chain and reads the address back out of it, so the set of keys the oracle will
listen to is derived from Intel's certificate chain rather than asserted by a deployer. Each answer
is then signed over `sha256hex(requestBody) + ":" + sha256hex(responseBody)`, and the oracle rebuilds
both of those bodies itself before checking the signature.

## Refusals

Refusing is the mechanism, so every refusal is named, emitted, and queryable.

**Per member** — recorded as `VerdictRejected`, the member is dropped and the round continues:

| Reason | Cause |
| --- | --- |
| `BadSignature` | the signature does not match the request and response the chain rebuilt |
| `UnknownSigner` | the recovered address was never attested |
| `SignerExpired` | the attestation aged past the registry TTL |
| `SignerRevoked` | the key was withdrawn |
| `Truncated` | the generation stopped early, so `finish_reason` was not `stop` |
| `Malformed` | prose, markdown, or anything other than the one permitted answer line |
| `OutOfRange` | a value of zero, an absurd value, or a confidence above 100% |
| `LowConfidence` | the model answered but below the confidence floor for this asset |
| `Stale` | the timestamp inside the signed response is outside the freshness window |
| `DuplicateSlot` | two answers claim the same committee seat |

**Per round** — recorded as `Halted`, nothing is published:

| Reason | Cause |
| --- | --- |
| `InsufficientQuorum` | too few members survived, or too few distinct enclaves among them |
| `Disagreement` | a surviving answer sits further from the median than the agreement band allows |
| `SequencerDown` | the L2 sequencer is down, or inside its recovery grace period |

A halt is sticky. Until a later round succeeds, `requireFreshNav` reverts and every consumer is
frozen. That is deliberate: the alternative is serving a price nobody stands behind.

---

## Contracts

| Contract | Responsibility |
| --- | --- |
| `AttestationRegistry` | Verifies Intel TDX quotes through a pluggable verifier, derives the signing address from the verified `report_data`, binds it to a model, expires it, revokes it. |
| `AssetRegistry` | Immutable prompt schemas plus per-asset policy: committee membership, quorum, agreement band, confidence floor, freshness window, dispute bond. Rebuilds request bytes on demand. |
| `AssayOracle` | Runs a round: rebuilds and hashes both bodies, recovers and authorises each signer, parses strictly, takes the median, enforces the band, records halts, settles disputes. |
| `AssayVault` | ERC-20 shares in a real-world basket, subscribed and redeemed at the attested unit price, blocked whenever the oracle refuses. |
| `UnverifiedQuoteAdapter` | A labelled non-verifying stand-in for throwaway networks. `isTrusted()` returns `false` so any interface can flag a deployment still pointing at it. |

## Anyone can list an asset

Assay is a primitive, not an application. Listing is permissionless:

```solidity
assetRegistry.registerAsset(
    keccak256("my-asset-key"),
    AssetConfig({
        issuer: msg.sender,
        quorum: 3,                 // how many members must answer validly
        minDistinctSigners: 2,     // how many separate enclaves among them
        bandBps: 1000,             // 10% agreement band around the median
        minConfidenceBps: 5000,    // reject answers below 50% confidence
        maxAgeSec: 3600,           // how fresh a signed answer has to be
        disputeBandBps: 500,       // how far a re-appraisal may drift before a challenge wins
        disputeBond: 0.01 ether,
        schemaId: SCHEMA_APPRAISAL_V1,
        active: true
    }),
    committeeModelIds,
    "ipfs://..."
);
```

Consumers only need one call:

```solidity
uint256 unitPriceE6 = oracle.requireFreshNav(assetId); // reverts unless the price is attested,
                                                       // agreed, fresh and unchallenged
```

## Quick start

```bash
git clone <this repo> && cd assay
forge install
forge test
```

Deploy to X Layer testnet:

```bash
export PRIVATE_KEY=0x...
forge script script/Deploy.s.sol \
  --rpc-url https://testrpc.xlayer.tech --broadcast \
  --verify --verifier sourcify --chain-id 1952
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `PRIVATE_KEY` | deployer key | required |
| `QUOTE_ADAPTER` | on-chain Intel DCAP verifier adapter | deploys the labelled stand-in |
| `CURRENCY` | settlement token for the vault | deploys a six-decimal demo token |
| `SEQUENCER_FEED` | Chainlink L2 uptime feed | uptime check skipped |
| `ASSET_KEY` | string hashed into the listed asset id | `assay.carbon.demo.v1` |

On X Layer mainnet, `CURRENCY` should be the canonical USDC at
`0x74b7F16337b8972027F6196A17a631aC6dE26d22` and `SEQUENCER_FEED` the Chainlink uptime feed at
`0x45c2b8C204568A03Dc7A2E32B71D67Fe97F908A9`.

## Deployments

| | X Layer mainnet (196) | X Layer testnet (1952) |
| --- | --- | --- |
| `AutomataDcapAttestation` | *pending* | *pending* |
| `AutomataTdxAdapter` | *pending* | *pending* |
| `AttestationRegistry` | *pending* | *pending* |
| `AssetRegistry` | *pending* | *pending* |
| `AssayOracle` | *pending* | *pending* |
| `AssayVault` | *pending* | *pending* |

X Layer had no on-chain Intel DCAP verifier before this, so `assay/dcap` deploys one: the Automata
verifier stack with its on-chain collateral store, wired to the RIP-7212 P-256 precompile that X
Layer exposes at `0x100`. A full TDX quote verification costs about 4.6M gas, which at X Layer gas
prices is roughly 0.0001 OKB. `dcap/README.md` covers deployment, the collateral refresh cycle, and
the gotchas.

## Repository

```
src/            the protocol
  AssayOracle.sol           rounds, parsing, consensus, halts, disputes
  AttestationRegistry.sol   which enclave keys the oracle will listen to
  AssetRegistry.sol         listings, policy, immutable prompt schemas
  AssayVault.sol            tokenised shares priced by the oracle
  adapters/                 quote verifier adapters
dcap/           deploys the on-chain Intel DCAP verifier to X Layer
backend/        the appraisal service: evidence, committee calls, verdict bundles
sdk/            typed client, verification helpers, and the assay-verify CLI
mcp/            read-only MCP server so an agent can consult the oracle
web/            the dashboard
docs/           threat model, evaluation protocol, verification guide
```

## Further reading

- [`docs/VERIFY.md`](docs/VERIFY.md) — check every claim yourself, in five minutes, with no credentials.
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — what we tried to break, what held, and what is still open.
- [`docs/EVAL.md`](docs/EVAL.md) — the evaluation protocol, written before the evaluation ran.

## License

MIT.
