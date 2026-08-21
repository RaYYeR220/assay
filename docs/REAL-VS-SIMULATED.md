# What is real and what is not

A line-by-line account of which parts of this project touch the real world and which are stand-ins,
so nobody has to guess. Anything not listed as a stand-in is real.

## Real

| Thing | What makes it real |
| --- | --- |
| Intel TDX quotes | Fetched live from the confidential inference provider's public attestation endpoint. Not synthesised, not replayed from a vendor sample. |
| On-chain attestation verification | The Automata DCAP verifier stack, deployed by us to X Layer, checking the PCK certificate chain to Intel's root with the RIP-7212 P-256 precompile. It really verifies; it does not stub out and return true. |
| The signing address | Read out of `report_data` in the verified quote. No configuration path exists to set it by hand. |
| Per-answer signatures | secp256k1 over `sha256hex(request) + ":" + sha256hex(response)`, produced inside the enclave, recovered on chain with `ecrecover`. |
| Carbon evidence | Real registry records: Puro.earth project pages, Verra project identifiers, and the Berkeley Voluntary Registry Offsets Database. Issuance, retirement, buffer and status figures come from those sources, cited per case. |
| Reference prices | Public, dated, and cited: exchange settlements, published indices, and live marketplace asks. Sources and their disagreements are listed in `backend/data/SOURCES.md`. |
| Contracts | Deployed and source-verified on X Layer. |

## Stand-ins, and where they are allowed

| Stand-in | Where | Why it is not a problem |
| --- | --- | --- |
| `UnverifiedQuoteAdapter` | Deployable, but only used when no DCAP verifier address is supplied | Named so it cannot be mistaken for the real thing on an explorer, and `isTrusted()` returns `false` so any interface can flag a deployment still pointing at it. The mainnet deployment does not use it. |
| `DemoUSD` | Test networks only | Test networks have no canonical stablecoin. The mainnet vault settles in canonical USDC. |
| `MockQuoteAdapter`, `MockSequencerFeed`, `MockERC20` | `test/` only | Never deployed. They exist so the test suite can drive states that cannot be produced on demand, such as a sequencer outage. |

## Deliberately modified evidence

Three evaluation cases contain evidence that was altered on purpose, because the defect being tested
does not exist in any real record we could find. Each is marked as such in `backend/data/SOURCES.md`
and none of them is used outside the evaluation:

- **T1** takes a real project record and swaps its issuance and retirement figures, to produce an
  internal contradiction.
- **T2** replaces a real methodology identifier with one that exists in no registry.
- **T5** takes a real project record and inserts a transaction price an order of magnitude away from
  any plausible value. This is the anchoring trap, and `docs/EVAL.md` predicted before the run that
  the oracle would fail it.

**T4 is not modified.** The Kariba project record is used exactly as the registries report it,
including its withdrawal from the programme and the excess credits identified against it. It is the
strongest case in the set precisely because nothing had to be invented.

## Things we would have liked to be real and are not

- **A second independent enclave.** All five committee members are fronted by one attested gateway
  trust domain, so they share a signing key. See `docs/THREAT-MODEL.md`.
- **A fillable market price for the primary asset.** The marketplace ask used as a reference for it
  carries zero available supply: it is a published quote rather than a fill. Corroborated against two
  independent indices, and flagged in `backend/data/SOURCES.md` rather than smoothed over.
