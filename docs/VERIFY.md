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
| An Intel TDX quote is verified on chain, not off it | *(pending deployment)* |
| The signing key was derived from that verified quote | *(pending deployment)* |
| A valuation was published from five TEE-signed answers | *(pending deployment)* |
| Shares were minted at that attested price | *(pending deployment)* |
| The committee disagreed and the oracle refused to price | *(pending deployment)* |
| The vault then reverted rather than transacting | *(pending deployment)* |
| A stale valuation stops consumers | *(pending deployment)* |
| A challenge freezes consumers before anyone adjudicates | *(pending deployment)* |
| A junk round changes nothing and is recorded as ignored | *(pending deployment)* |

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
one gateway enclave, and by default whoever posts a round also chooses the evidence. Each of those is
a real limit, each has a mitigation that is either implemented or named, and none of them is hidden.

`docs/EVAL.md` was written before the evaluation ran and contains a prediction that the system will
fail one specific case. The results section reports what actually happened, including where the
predictions were wrong.
