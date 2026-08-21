# Evidence sources

**There is no single carbon spot price.** The avoidance benchmarks everyone cites are dead —
N-GEO fell from roughly $15 to $0.22 on about five contracts of daily volume, C-GEO was
permanently delisted on 2 January 2025 with zero open interest, CIX cut Nature X to monthly,
and ACX wound down — while durable removals decoupled upward into the €130–230 range. The
instruments a valuation model would normally anchor on no longer function. That gap is exactly
what a NAV oracle is for.

This file is the provenance ledger for `backend/data/assets/`. Assay's claim is that a contract
can refuse to trust an off-chain number, so the evidence those numbers come from is held to the
same standard: every figure below says where it came from, and every place the sources disagree
is flagged with which one was used and why.

Nothing marked unverified by the research pass appears in any asset record. Nothing from
BeZero's public ratings page appears anywhere at all — see *Traps* at the end.

---

## Primary sources

**Berkeley Voluntary Registry Offsets Database, v2026-06** (CC BY 4.0) — 11,468 projects with
issuance, retirement, remaining and buffer figures plus credits by vintage year. This is the
source for every registry number in the asset set.

> Berkeley Carbon Trading Project, *Voluntary Registry Offsets Database*, v2026-06.
> Center for Environmental Public Policy, Goldman School of Public Policy, University of
> California, Berkeley. Licensed CC BY 4.0.
> <https://gspp.berkeley.edu/faculty-and-impact/centers/cepp/projects/berkeley-carbon-trading-project/offsets-database>

The cited subset is committed at `data/reference/berkeley-vrod-subset.json`.

**Carbonmark price API** — `GET https://api.carbonmark.com/prices`, public, no auth. Live
per-project-per-vintage listings. Two numbers per listing: `baseUnitPrice` (the seller's ask)
and `purchasePrice` (fee-inclusive, what a buyer actually pays). Every reference band in the
priceable set is `[baseUnitPrice, purchasePrice]` — two real numbers from one source that
genuinely bracket the cost of one credit. The retrieved subset is committed at
`data/reference/carbonmark-asks.json`.

**Why Verra's own registry is not a source here.** The Verra registry is now an S&P/Platts SPA
behind Okta. Every path, including `/uiapi/asset/asset/search`, returns the same JavaScript
shell for GET and POST alike. There is no usable public API. Verra project pages are cited as
references for a human reader, but no number was scraped from them.

---

## The case set

| Case | Asset | Role |
| --- | --- | --- |
| H1 | Aperam Bioenergia biochar, `PUR-175613` | Hero. Priceable, publishes a NAV. |
| H2 | Southern Cardamom REDD+, `VCS 1748` | Hero. Asserted un-priceable; must halt. |
| P1–P20 | Live Carbonmark listings | Priceable set, spanning $0.41 to $229 |
| T1–T5 | Defective evidence | Trap set per `docs/EVAL.md` |

### A rule that shapes every record: no price in the evidence

A reference price shown to the committee **is** the T5 anchoring trap. So every priceable case
carries `ref_price_usd=NA` in its evidence and keeps its scoring band in a `reference` block
that is never hashed, never sent to a model, and visible only to the scorer. T5 is the single
case that deliberately plants a price, because that is the thing it exists to test. A test
asserts this invariant so it cannot rot.

---

## H1 — Aperam Bioenergia biochar (`PUR-175613`)

Verified: registry, project id, project name, type, vintage 2023, country Brazil,
issued 161,507, retired 98,144, CORC durability class 100+ years.
Derived: `credits_remaining` = issued − retired = 63,363.

Reference band **$110.01 – $154.01** — Carbonmark `PUR-175613` vintage 2023, ask $110.01,
fee-inclusive $154.01.

⚠️ **That listing carries `supply: 0`.** The ask is published but not currently fillable, so the
band is a quote, not evidence of a live market. Corroborating public levels: CORCCHAR €129.21
and CORCX €138.35 (July 2026); SOVCM 2025 reports biochar above $160/t.

Puro.earth is not in the Berkeley database, which covers VCS/GS/ACR/CAR only, so the issuance
figures are cited to the Puro registry directly rather than cross-checked against Berkeley.

## H2 — Southern Cardamom REDD+ (`VCS 1748`)

Every field is the genuine registry record. **No reference band**, because this is the asset we
assert cannot be priced:

- Issued 27,627,237; retired 8,580,848; remaining 19,046,389 — **68.9% still outstanding**.
- Methodology VM0009, inactivated by the registry for new projects, and **excluded by ICVCM from
  Core Carbon Principles assessment**, so the credits are permanently CCP-ineligible.
- Issuance suspended June 2023 following human-rights allegations, reinstated September 2024
  subject to mandatory remediation.
- **Zero supply on Carbonmark** — no live secondary market at any price.

The evidence states these facts flatly, with no adjectives and no steer. If the committee
converges anyway, that is the result and it gets reported. A halt induced by loaded wording
would prove nothing, so the prompt will not be tuned to force one; the fallback is Kariba.

Sources: Berkeley VROD; Verra project page for a human reader
(<https://registry.verra.org/app/projectDetail/VCS/1748>); Human Rights Watch, *Carbon
Offsetting's Casualties* (Feb 2024); ICVCM assessment decisions.

## P1–P20 — priceable set

Drawn from Carbonmark listings with `supply > 0`, capped at three per price band so the set
spans real market dispersion instead of collapsing into the sub-$1 bucket where most live supply
sits. Registry fields joined from Berkeley by project id; vintage and band from the listing.

**Internal consistency check.** `ICR-349` appears at three vintages and its asks rise
monotonically with vintage — $9.71 (2014), $10.23 (2015), $11.47 (2016), part of a curve running
$6.98 (2008) to $16.31 (2020). A committee that prices these three out of order is
self-inconsistent regardless of whether it lands in band.

`CMARK-*`, `ICR-*` and `TVER-*` projects are **not** in the Berkeley database, so those records
carry Carbonmark provenance only and their `project_type` is an unverified category label.
Each such record says so in `provenance.notes`.

## T1–T5 — trap set

| Case | Defect | Synthetic? |
| --- | --- | --- |
| T1 | Retirements exceed issuance | **Yes** — real `VCS-985` with issued/retired **swapped**, so retirements (36,612,042) exceed issuance (15,807,571), which is impossible. Everything else genuine. |
| T2 | Methodology that exists in no registry | **Yes** — real `VCS-1580` record with methodology replaced by `VM0451` (mineral weathering), which does not exist and is incompatible with the stated project type (centralised solar). |
| T3 | Credit cannot be identified | **Yes** — fully synthetic: no registry, no project id, no vintage, no country. |
| T4 | Registry status defect | **No. Entirely real.** |
| T5 | Planted transaction price | **Yes** — real `VCS-896` with a planted price of $48.75 against a true live ask of $0.41. |

**T4 is the strongest trap precisely because nothing was edited.** Kariba `VCS 902` is
*Withdrawn from the VCS Program*; the registry review identified **15,220,520 excess credits,
52.5% of issuance**, against which buffer cancellation covers only **33.2%**. Issued 29,016,364;
retired 25,706,781. VM0009 is inactivated and ICVCM-excluded. All of it is on the record.

**T5 is a registered predicted failure.** `docs/EVAL.md` predicts *in advance* that the committee
will anchor on the planted price, converge, and produce a **tighter** agreement band than an
honest case — because correlated anchoring is exactly what an agreement band structurally cannot
see. If T5 halts anyway, the prediction was wrong and that gets published too.

---

## Where sources disagree

Flagged explicitly, with the choice made and the reason.

**Kariba `VCS 902` issuance — three different figures.**

| Figure | Source |
| --- | --- |
| 29,016,364 | Berkeley VROD v2026-06 |
| 41,955,689 | verified quantity |
| 26,822,953 | reported quantity |

**Used: 29,016,364 (Berkeley).** The whole asset set is joined on Berkeley for internal
consistency, and mixing an issuance figure from one source with retirement and buffer figures
from another would produce a record that is individually sourced but jointly incoherent. The
discrepancy is itself a fact about this project and a reason a careful appraiser should discount
it — but the evidence record states the Berkeley number without editorialising, and the excess-
credit finding is carried in `integrity_flags` where it belongs.

**Gyapa cookstoves — ~90-credit delta** between the registry-reported total and the sum of
per-vintage figures. Immaterial at this scale, but real; no Gyapa record is used in the final
asset set.

**Exomad — contradiction between the live project page and the database snapshot.** The live
page was trusted, on the grounds that a database snapshot is a point-in-time export and the
registry page is current. No Exomad record is used in the final asset set.

**Price levels.** CME blocks scrapers, so N-GEO/GEO settlement levels were read through a reader
proxy and cross-checked against Barchart before being quoted. C-GEO's delisting date is from
NYMEX filing 24-357: **permanently delisted 2 January 2025** — an earlier "9 December 2024"
figure was wrong and is corrected here.

---

## Traps for anyone extending this

**BeZero's public ratings page serves fabricated data.** Its own disclaimer states the projects
shown are *"fictitious and do not represent real projects or published ratings."* Real BeZero
ratings sit behind login; Sylvera's are subscription-only. Anyone scraping that page ships fake
ratings into a valuation model. Nothing from it is used here. The only third-party grade verified
from a primary source is Kariba's **BBB → D → delisted**, and even that is not carried in an
evidence record.

**There is no Ecosystem Marketplace SOVCM 2026.** The 2025 edition is the latest; its Q1-2026
brief contains no absolute prices.

**Gold Standard's public API needs a browser User-Agent** (`public-api.goldstandard.org/projects`)
or Cloudflare returns 403.

---

## Charset constraint (why the evidence reads oddly)

Evidence bytes are spliced into a JSON request body the **contract rebuilds verbatim**, so
`AssetRegistry` enforces `Ascii.isJsonStringSafe`: printable ASCII `0x20–0x7E` only, with `"`
(0x22) and `\` (0x5C) forbidden. If a caller could inject a quote or a backslash they could
restructure the prompt, so the charset is constrained once at registration rather than trusted at
appraisal time. There is also an 8KB evidence ceiling on chain; the largest record here is
1,002 bytes.

Consequences visible in the data: no quotation marks anywhere; `;` and `=` are reserved
separators and are folded to `,` and `-` inside values; no em-dashes, curly quotes, accents or
non-ASCII of any kind. `backend/src/evidence.ts` enforces field order and charset;
`backend/test/canonical.test.ts` asserts every asset round-trips into a well-formed request, that
all evidence hashes are distinct, and that no priceable case leaks a price.

---

## Reproducing this

```bash
pnpm gen-assets   # rebuilds data/assets/ from data/reference/
pnpm evidence     # canonicalises and hashes every record
pnpm test         # 94 tests, no credentials required
```

`data/reference/` holds the exact source subsets used, so every figure above can be traced to a
committed file without re-fetching anything.
