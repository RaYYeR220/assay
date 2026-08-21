# Assay backend

The off-chain half of the NAV oracle: it builds the exact request bytes the contract will
rebuild, calls N TEE-hosted models, collects each enclave signature, and re-runs the entire
on-chain check locally before anything is submitted.

The contract trusts nothing this service says. That is the point. Everything here exists to
make sure that when the chain re-derives the answer itself, it agrees — and to name the exact
check that failed when it does not.

## Run it

```bash
pnpm install
pnpm discover     # -> data/committee.json   (no API key needed)
pnpm gen-assets   # -> data/assets/          (no API key needed)
pnpm evidence     # -> data/evidence.json    (no API key needed)
pnpm test         # 94 tests, no API key needed
pnpm serve        # http://127.0.0.1:8787
```

With `REDPILL_API_KEY` set (env, or `internal/.env`):

```bash
pnpm probe        # one live call + byte-exactness brute force -> data/byte-exactness.json
pnpm compliance   # 5 samples x 5 models: who actually emits the required line?
pnpm appraise <assetId>          # full 5-slot round -> data/bundles/
pnpm eval --set all              # run the committed docs/EVAL.md protocol
pnpm eval --score-only           # score recorded bundles with ZERO credentials
pnpm replay                      # re-verify recorded bundles with ZERO credentials
```

## Posting a round takes two transactions

The evidence commitment is mandatory. `postAppraisal` reverts with `EvidenceNotCommitted`
unless the issuer has already committed the digest:

```
1. issuer:  AssetRegistry.commitEvidence(assetId, sha256(evidence), uri, true)
2. anyone:  AssayOracle.postAppraisal(assetId, evidence, verdicts)
```

Without step 1 anyone could invent evidence, buy genuine enclave signatures over it, and
move the NAV at will — deflate, subscribe, inflate, redeem, vault drained in one
transaction. `GET /assets/:id` returns the exact `commitEvidence` call whenever the digest
is not known-committed, and `preflightVerdict` reports it as `roundBlocker` (a ROUND
failure, distinct from a per-verdict rejection) rather than letting it surface as an opaque
revert. Set `ASSAY_RPC_URL` + `ASSAY_ASSET_REGISTRY` to check it for real; unset, the state
is reported as UNKNOWN and never assumed fine.

## The one invariant

```
requestBody = head || utf8(modelId) || mid || evidence || tail
text        = sha256hex(requestBody) + ":" + sha256hex(responseBody)     // 129 chars
digest      = keccak256("\x19Ethereum Signed Message:\n129" || text)
signer      = ecrecover(digest, signature)                                // must be attested
```

`head` / `mid` / `tail` are **not defined in this codebase**. They are exported from
`script/Schema.sol` into `assay/schema.appraisal.v1.json` and loaded at runtime by
`src/canonical.ts`. If Solidity changes the template, this service follows automatically and
the tests fail loudly if it ever drifts.

Request bytes are POSTed as a `Buffer`, never as an object — no layer between us and the
socket is allowed to re-serialise the JSON.

## Layout

| Path | What it is |
|---|---|
| `src/canonical.ts` | Request assembly, hashing, ecrecover, offset discovery, the on-chain parser mirror, and `preflightVerdict` |
| `src/evidence.ts` | Canonical `key=value;...` evidence line, charset-enforced |
| `src/redpill.ts` | Typed gateway client (models, attestation, chat, signature) |
| `src/appraise.ts` | One 5-slot committee round -> a submittable bundle |
| `src/prompt.ts` | Reads the prompt back **out of** the schema; defines nothing |
| `src/server.ts` | HTTP API |
| `scripts/discover-committee.ts` | Enumerates TEE models, pulls attestations, picks the committee |
| `scripts/probe-live.ts` | The live byte-exactness experiment |
| `scripts/compliance.ts` | Measures per-model adherence to the answer grammar |
| `scripts/gen-assets.ts` | Builds the case set from the committed reference data |
| `scripts/run-eval.ts` | Implements the `docs/EVAL.md` scoring protocol |
| `data/reference/` | The exact public-source subsets every figure is traced to |
| `data/SOURCES.md` | Provenance ledger, including where sources disagree |

## The case set

27 assets, all derived from public registry and market data (`pnpm gen-assets`):

| Case | What |
|---|---|
| H1 | Aperam Bioenergia biochar `PUR-175613` — priceable, publishes a NAV |
| H2 | Southern Cardamom REDD+ `VCS 1748` — asserted un-priceable, must halt |
| P1–P20 | Live Carbonmark listings spanning $0.41 to $229 |
| T1–T5 | Defective evidence per `docs/EVAL.md` |

**No priceable case carries a price in its evidence.** A reference price shown to the committee
*is* the T5 anchoring trap, so scoring bands live in a `reference` block that is never hashed and
never sent to a model. A test enforces this.

## API

| Endpoint | Needs a key? | Purpose |
|---|---|---|
| `GET /health` | no | Status, schema id, asset list |
| `GET /committee` | no | `committee.json` + live attestation freshness |
| `GET /assets`, `GET /assets/:id` | no | Assets and their canonical evidence |
| `GET /request-template` | no | The exact bytes Solidity must reconstruct, with a worked example |
| `POST /inspect` | no | Offsets + on-chain parse verdict for any response body |
| `POST /verify` | no | ecrecover any `{requestBody, responseBody, signature}` |
| `GET /bundles`, `GET /bundles/:n`, `GET /bundles/:n/verify` | no | Replay and re-verify recorded rounds |
| `POST /appraise {assetId}` | **yes** | Live committee round |

Only `POST /appraise` needs credentials, and it returns a clear 503 rather than a mystery
when the key is absent. Everything a judge needs to re-verify a result is keyless.

## Things that will bite you

- **The gateway signature endpoint needs the SAME bearer token** used for the completion.
  Receipts are owned by `sha256(token)`; a different token gets a 404, no token gets a 401.
- **Receipts live 1 hour, in memory only.** A gateway restart drops them. Fetch the
  signature immediately after the completion, never lazily.
- **`max_tokens` is pinned to 512 by the schema** and cannot be changed per-request. That is
  ample headroom, but reasoning models are still excluded: we cannot send `reasoning: false`
  without breaking every signature, and a model that inlines chain-of-thought into `content`
  emits prose before the `ASSAY1` line, which the parser rejects as `Malformed` every round —
  a permanent dead slot rather than a noisy one. See `tokenBudgetRisk` in `committee.json`.
- **`Verdict` is `{slot, responseBody, signature}` — the offset hints were deleted.** They
  travelled outside the signed payload, so anyone watching the mempool could copy a pending
  round, corrupt an offset, land first and halt the oracle for the cost of gas. The contract
  scans for each pattern itself. A test reads `out/AssayOracle.sol/AssayOracle.json` and
  asserts the packed tuple matches the compiled ABI, so a struct change fails the build
  rather than producing an unencodable call.
- **Check order is load-bearing.** Freshness is established BEFORE the answer is parsed:
  body bounds → signature → attestation → timestamp readable (`NoTimestamp`) → skew → max
  age → watermark → answer grammar → confidence. If a malformed answer could count toward
  `authed` without first proving it is recent, one authentic-but-unparseable response would
  be a bearer token that halts the asset forever. `preflightVerdict` mirrors this order.
- **An empty or oversize body is `BadSignature`, not `Malformed`** — nothing was
  authenticated, so it must not land on the authenticated side of the round.
- **The parser tolerates trailing whitespace**, up to 8 items of a literal space or the
  escapes `
`, `
`, `	`, before requiring the closing quote. A model ending its line with
  a newline is a PASS. Nothing else is tolerated — a trailing period or word still rejects.
- **Slot order comes from `script/Deploy.s.sol`, not from discovery.** `modelAt(assetId, slot)`
  is checked against the recovered signer, so appraising in a different order invalidates every
  verdict. `src/slots.ts` parses the deployed array; a test asserts they match.
- **`response_format` is deliberately not sent.** It is absent from the on-chain schema, so
  adding it would change the request bytes and break every signature. Grammar compliance is a
  measured prompt-adherence property, not a configured guarantee.
- **All five slots are submitted every round.** An unavailable model is packed with an empty
  `responseBody` so the chain rejects it visibly, rather than being omitted and quietly
  shrinking the committee.
