# Threat model

Assay publishes a number that other contracts move money against, and it derives that number from
language models. This document is the list of ways we tried to break it, what the code does about
each one, and what is still open. The last section is the important one.

## Trust assumptions

We assume Intel's DCAP root of trust is sound, that a verified TDX quote means the enclave really is
running the measured image, and that a key derived inside that enclave is not extractable. We assume
the X Layer sequencer can be down but not malicious. We do not assume anything about the relayer who
posts a round, about the models themselves, or about the network in between.

## Attacks and answers

### Substituting a friendlier question
An appraisal is only meaningful relative to what was asked. If the relayer chose the prompt, it could
ask a leading question and post the answer as an appraisal.

The prompt fragments live in `AssetRegistry` and are immutable once written. `AssayOracle` rebuilds
the request bytes as `head || modelId || mid || evidence || tail` and hashes those, so a signature
only verifies against the question the registry defines. Evidence is charset-restricted to bytes that
cannot contain a quote or a backslash, which stops evidence from breaking out of its JSON string and
restructuring the request around it.

### Editing the answer in transit
The signature covers `sha256hex(requestBody) + ":" + sha256hex(responseBody)`, and the oracle hashes
the raw response bytes it was handed. Changing a single digit of the returned value changes the
digest, and the recovery then yields an address that was never attested.

### Nominating your own signer
An operator who could name signing addresses could name their own. `AttestationRegistry` has no such
path. The only way in is `registerSigner`, which verifies a TDX quote and reads the address out of
the verified `report_data`. Registrations also expire, so a retired or compromised enclave falls out
of the set without anyone needing to act.

One part of that call is a claim rather than a proof, and it is worth being precise about which. A
TDX quote attests the enclave; it says nothing about which model that enclave fronts. So the binding
between an attested key and a model identifier is asserted by whoever curates the registry, and
`registerSigner` is gated accordingly rather than dressed up as something Intel vouches for. Leaving
it open would also have meant anyone could re-submit an old quote indefinitely, which would make the
attestation lifetime prove nothing about liveness.

### Inventing the facts
The signed payload commits to the request, and the request contains the evidence — but if whoever
posts a round also *chooses* the evidence, the whole chain rests on an input nothing checks. Someone
could invent a record, buy genuine enclave signatures over it from a public inference endpoint, drive
the valuation down, subscribe, drive it back up and redeem, in a single transaction.

So evidence is not caller-supplied in any meaningful sense: the issuer must commit `sha256(evidence)`
to the registry in advance, and a round using anything else reverts. Posting stays permissionless.
Choosing what a round is about does not. Three roles, separated: the issuer commits to what the
evidence *is*, the committee decides what it is *worth*, and the chain checks both.

### Holding a bad answer until it is useful
A rejection that counts toward the authentication threshold is what allows a round to halt, so an
authentically-signed response that fails to parse must not be usable forever. Freshness and the
replay watermark are therefore established *before* the answer is read: a verdict only reaches the
counted rejections if it is recent and newer than the last published round. Otherwise one unparseable
but genuine response would have been a permanent off switch for that asset.

### Cherry-picking answers across time
Signatures stay valid for the whole freshness window, so a relayer could hold a favourable set of
answers and post them after a later round disagreed. `observationWatermark` records the newest
accepted timestamp of the last published round, and every accepted answer must be strictly newer than
it, which retires a whole round of answers the moment they are used. The watermark deliberately does
not advance on a halted round, so a genuine retry after one member arrives late still works.

### Hiding the member who disagrees
A consensus rule is only as good as the completeness of the sample. `postAppraisal` requires a verdict
for every committee slot, so an absent member has to be submitted as an empty answer, which is
rejected visibly on chain and still counts against quorum.

### Freezing the oracle with junk
Halting is a strong action and `postAppraisal` is permissionless, so an attacker could otherwise
freeze every consumer with one transaction of nonsense. A round only halts if at least `quorum`
verdicts carried a signature from a live attested key. Rounds below that threshold emit `RoundIgnored`
and change nothing. A real committee outage is still handled, just differently: the last valuation
ages out and consumers freeze on staleness instead.

### Freezing the oracle with a challenge
Opening a challenge stops consumers immediately, by design, so it cannot be free or unbounded. A
challenge costs the issuer-set bond, `resolveDispute` refuses to settle on an unauthenticated round,
and after `challengeWindow` anyone can call `lapseDispute`, which returns the valuation to service
and pays the bond to the issuer.

### Signature malleability and degenerate signatures
`_recover` rejects any `s` above the curve order midpoint, any `v` outside 27 and 28, and anything
that is not exactly 65 bytes, and treats a zero recovery as a failure rather than a match.

### Lying about where to read the answer
Nobody gets to say where the answer is. An earlier version let the caller pass byte offsets so the
contract could jump straight to each field, which was cheaper and quietly broken: the offsets were
not covered by the signature, so anyone watching the mempool could copy a pending round, corrupt
three integers, land first, and turn five perfectly good answers into a halt for the price of gas.
The offsets are gone. The contract scans for the patterns itself, and a verdict now carries nothing
that is not either signed or self-validating. The patterns begin with an unescaped quote, which
cannot occur inside a JSON string value, so the first occurrence is necessarily the real one and a
model cannot fabricate a second copy inside its own output.

### Replaying a verdict against a different asset
The signed payload commits to the request bytes, which are `head || modelId || mid || evidence ||
tail`. It does not name the asset, and it cannot: the format is dictated by the inference gateway,
not by us. Two assets that share a prompt schema and a committee will therefore accept each other's
verdicts whenever they are shown the same evidence. In practice the evidence identifies the asset, so
the request bytes differ and the verdicts do not transfer; but the separation rests on that
convention rather than on the signature. Mandatory evidence commitment closes it in practice, since a round can
only use a digest the issuer of that specific asset committed.

### A model that answers in prose
Rejected. The content must be exactly the marker line, with only literal spaces and escaped
whitespace permitted before the closing quote. A truncated generation is caught separately, because
`finish_reason` must be `stop`.

### Reentrancy, and payments that refuse to land
The oracle settles all state before any value transfer and marks disputes closed before paying. It
does not push bonds at all: a resolution credits an account and the recipient withdraws. Pushing
would have meant an issuer address that cannot receive value — a contract with no payable fallback,
say — made every resolution revert, and since an open challenge freezes consumers, the asset would
have been bricked with no way back. Nobody should be able to take an oracle offline by choosing an
awkward address. The vault is `nonReentrant` on both value-moving entry points.

## Open, and why

**The committee is not deterministic.** Measured, not theorised: the same model, sent byte-identical
request bytes at temperature zero, returned valuations spanning a factor of ten across repeated
rounds. One member drove almost all of it; the others were stable. So publication is a *rate* rather
than a guarantee, and a caller may have to run several rounds before one clears the band. Every
attempt that does not clear is recorded on chain as a halt with its reason, which is what keeps
retrying honest — the failures are as public as the successes. `docs/EVAL.md` has the numbers.

**Agreement is not accuracy.** This is the honest limit of the design and no amount of cryptography
fixes it. Five models can agree tightly and all be wrong, particularly when the evidence contains a
number that invites anchoring. The agreement band measures consensus, not truth. Committee diversity
and `minDistinctSigners` reduce correlated failure, and the dispute bond gives someone with better
information a way to intervene, but a confidently wrong committee produces a confidently wrong price.
We consider this the most important thing a reader should know about Assay, which is why it is here
rather than in a footnote.

**The issuer is trusted for the facts.** Evidence commitment moves the problem rather than dissolving
it: the chain now knows the evidence is the one the issuer stood behind, and knows nothing about
whether it is true. An issuer who commits a flattering record gets a valuation of a flattering
record. What the design buys is that the party choosing the facts is named, on chain, in advance, and
is not the same party that posts the round or the one that prices it.

**On the deployed committee, the five models share one enclave.** This is the sharpest limitation of
the live configuration and it deserves to be stated plainly rather than buried. The confidential
inference provider fronts every model through a single attested gateway trust domain, so all five
committee members sign with the same key. Model diversity is real and it is enforced — the contract
rebuilds each request with that slot's model identifier before checking the signature, so a verdict
cannot be moved between slots — but *enclave* diversity on that committee is one, and
`minDistinctSigners` is therefore set to 1 rather than to a number that would sound better.

What that costs: a compromise of the gateway image, or a gateway that lies about which model it
routed to, would not be caught by the committee, only by the measurement allowlist. What it does not
cost: nobody outside that enclave can forge a verdict, and the measurement of the gateway software is
verified against Intel's root of trust on every registration.

We looked for a second signer and could not buy one honestly. The same provider does run a fleet of
eleven separate trust domains behind another model, and those quotes verify, but that fleet exposes
no per-response signing key at all, so its answers cannot be checked by a contract. Registering it
would have produced a listing that looks diverse and can never actually post a verdict, which is
worse than admitting the limit. `minDistinctSigners` is enforced and covered by tests, and a
deployment spanning two providers should set it above 1; ours cannot yet, so it does not.

**Governance can widen the response grammar.** The owner can change which byte patterns count as a
well-formed answer. That cannot manufacture a signature, so the worst case is denial of service or an
overly permissive parse, but it is a privileged surface and it belongs on this list rather than out
of sight.


## What a review found

An adversarial review of this code, run before deployment, found two critical defects. Both are
fixed, and both are recorded here rather than quietly patched, because how a system fails review says
more than the fact that it passed one.

**An unparseable but authentic answer was a permanent halt token.** Rejections that count toward the
authentication threshold were evaluated before freshness, so a single genuinely-signed response that
failed to parse never expired and could be resubmitted to halt the asset indefinitely. Freshness and
the watermark now precede the answer.

**Anyone could price any asset.** Asset identity lived entirely in caller-supplied evidence, and
enclave signatures can be bought from a public endpoint, so a round could be manufactured over
invented facts and used to move a valuation in both directions inside one transaction. Evidence
commitment became mandatory.

The review also produced fixes for a signature-covered-versus-not asymmetry in the parser hints
(removed outright), a push payment that could brick an asset mid-dispute (now pull), a freshness
window an issuer could widen retroactively (now snapshotted), and an attestation refresh anyone could
perform forever (now curated). The test suite covers each of them.
