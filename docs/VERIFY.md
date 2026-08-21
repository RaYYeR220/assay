# Verify it yourself

Everything Assay claims is checkable from public data. No account, no API key, no wallet. This page
is the short path: five minutes, one command, and a list of the exact transactions behind each claim.

## The one command

```bash
cd sdk && pnpm install && pnpm assay-verify --chain 196
```

It reads the deployment, then independently re-derives the conclusions the contracts reached and
prints a line per claim. It exits non-zero if anything fails, and prints `SKIPPED` with a reason for
anything it could not reach rather than reporting a pass it did not earn.

What it checks:

1. Every contract is deployed, and the attestation adapter is the real on-chain Intel DCAP verifier
   rather than the labelled stand-in.
2. Each registered enclave key, its measurement, TCB status, expiry, and the transaction where its
   Intel TDX quote was verified on chain.
3. That `report_data[0:20]` in the **live** attestation report served by the inference provider
   equals the signer address the contract registered. This is the link that proves the key on chain
   came out of an enclave rather than from an operator.
4. For recent rounds: rebuilds the request bytes from the on-chain prompt schema, hashes both bodies,
   reconstructs the signed text, recovers the address, and confirms it matches what the contract
   accepted.
5. That each published valuation equals the median of its accepted verdicts and that every accepted
   verdict sits inside the configured band.
6. The halt history with reasons, and that `requireFreshNav` currently behaves consistently with the
   recorded state.

## The claims, and the transaction behind each

Filled in from the live deployment. Every link goes to the explorer.

| Claim | Where to see it |
| --- | --- |
| An Intel TDX quote is verified on chain, and the signing key is read out of it | mainnet [`0x50b52408…`](https://www.oklink.com/xlayer/tx/0x50b52408e606ed443a24c6fe6284b8ea25ae000b7e1809954fa6fbf370e313b7) · testnet [`0x210cda7b…`](https://web3.okx.com/explorer/x-layer-testnet/tx/0x210cda7bed824377ef7d22e749ea972075ce83d7cb1193298ddf13f6aa09b453) |
| The approved enclave measurement was allowlisted before any key was accepted | mainnet [`0x8fa36e12…`](https://www.oklink.com/xlayer/tx/0x8fa36e12f87dd24c3d8939ffe78474d6b4fefaaf67c7c082540d6ff8d58a9e80) |
| The issuer committed the evidence digest before the round ran | mainnet [`0x48f3d375…`](https://www.oklink.com/xlayer/tx/0x48f3d375dcae708a388fc8628fb8395e0b1f538ff5ff8d22a414d08069d73392) |
| A valuation was published from TEE-signed answers — $1.10 per tonne | **mainnet** [`0x4058030a…`](https://www.oklink.com/xlayer/tx/0x4058030ad3407f4a5a93b8c14339872998c2f2c414dd99b256e3ecaa85b6a0c8) · testnet [`0x0cf21ef4…`](https://web3.okx.com/explorer/x-layer-testnet/tx/0x0cf21ef4bb14d42cf8d89d28276baef22468188263ad5496f7567772b1224b6b) |
| Shares were minted against that attested price | testnet [`0x58b49da7…`](https://web3.okx.com/explorer/x-layer-testnet/tx/0x58b49da7a90740721e88a22b9d316dee7fd7b50e8b09d8155466a068de6c755f) |
| The committee disagreed on a durable removal and the oracle refused to price | testnet [`0x03202470…`](https://web3.okx.com/explorer/x-layer-testnet/tx/0x0320247082a52231bd614d3e6b3aca52017501186056ef124eb68cb94fe298dc) |
| The models reported low confidence on a suspended project and the oracle refused | testnet [`0x38885242…`](https://web3.okx.com/explorer/x-layer-testnet/tx/0x3888524218efe1e78f7ab0db15606b31fc796b9ac45f4766a5e367d87520b6de) |
| **The vault then reverted rather than transacting at an unpublished price** | testnet [`0xbba4c376…`](https://web3.okx.com/explorer/x-layer-testnet/tx/0xbba4c376efd80d0246a17a909acbf4f68816f40ff3c4e2e677d27c71d4664a17) — a deliberately failed transaction |

## Checking the foundation

On-chain attestation verification here rests on X Layer exposing the secp256r1 precompile from
RIP-7212 at `0x100`. That is not an assumption you have to take on trust:

```bash
# a valid P-256 signature returns 1, a corrupted one returns nothing
cast call 0x0000000000000000000000000000000000000100 <hash||r||s||x||y> \
  --rpc-url https://rpc.xlayer.tech
```

It answers on both X Layer mainnet and testnet, which is what makes a full quote verification cost
around 4.6M gas instead of being priced out entirely.

## Reading a round by hand

If you would rather not trust our tooling either:

```bash
cast call $ORACLE "navOf(bytes32)" $ASSET_ID --rpc-url https://rpc.xlayer.tech
cast logs --address $ORACLE "VerdictRejected(bytes32,uint32,uint8,address,uint8)" \
  --rpc-url https://rpc.xlayer.tech
```

`RejectReason` and `HaltReason` are plain enums in `src/Types.sol`. A round tells its whole story
through `VerdictAccepted`, `VerdictRejected`, and then either `AppraisalPosted` or `Halted`.

## What we do not claim

Read `docs/THREAT-MODEL.md`, in particular the section titled "Open, and why". The short version:
agreement between models is not the same as being right, the five models on the live committee share
one gateway signing key, and the issuer is trusted for the facts even though nobody else is. Each of
those is a real limit, each has a mitigation that is either implemented or named, and none is hidden.

One more, measured today rather than theorised: on a durable carbon removal the committee split a
hundred-fold, because two of five models priced it as a generic offset instead of a removal. The
oracle refused, which is the correct outcome, but the refusal is a symptom of a real limitation —
model disagreement about *what an asset is* is not something an agreement band can repair.

`docs/EVAL.md` was written before the evaluation ran and contains a prediction that the system will
fail one specific case. The results section reports what actually happened, including where the
predictions were wrong.
