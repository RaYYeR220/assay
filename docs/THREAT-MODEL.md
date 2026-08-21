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
The offsets in a verdict are hints, and each is confirmed by matching the literal pattern at that
position before anything is read. A wrong hint produces a rejection, never a misread. The patterns
begin with an unescaped quote, which cannot occur inside a JSON string value, so a model cannot
fabricate a second copy of one inside its own output and have a hint point at it.

### A model that answers in prose
Rejected. The content must be exactly the marker line, with only literal spaces and escaped
whitespace permitted before the closing quote. A truncated generation is caught separately, because
`finish_reason` must be `stop`.

### Reentrancy
The oracle settles all state before any value transfer and marks disputes closed before paying. The
vault is `nonReentrant` on both value-moving entry points.

## Open, and why

**Agreement is not accuracy.** This is the honest limit of the design and no amount of cryptography
fixes it. Five models can agree tightly and all be wrong, particularly when the evidence contains a
number that invites anchoring. The agreement band measures consensus, not truth. Committee diversity
and `minDistinctSigners` reduce correlated failure, and the dispute bond gives someone with better
information a way to intervene, but a confidently wrong committee produces a confidently wrong price.
We consider this the most important thing a reader should know about Assay, which is why it is here
rather than in a footnote.

**Evidence quality is upstream of everything.** By default whoever posts a round also supplies the
evidence, which means the verification chain rests on an input the chain cannot check. Assets that
care should set `requireAllowedEvidence`, which forces the issuer to commit to an evidence digest in
advance and splits the roles apart: the issuer commits to what the evidence is, the committee decides
what it is worth, and the chain checks both.

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
