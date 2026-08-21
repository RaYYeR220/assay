# Evaluation protocol

This protocol was written and committed **before** the evaluation was run, so that the scoring rules
could not be chosen after seeing the results. Predictions, including one prediction that the system
will fail, are recorded in the Predictions section below. Results follow underneath.

## What is being measured

Two different things, and conflating them is the usual mistake:

1. **Does the committee land near a defensible value** when the evidence supports one?
2. **Does the oracle refuse** when the evidence does not support one?

The second matters more. A valuation oracle that is occasionally wrong is a normal financial
instrument. A valuation oracle that is confidently wrong when it should have abstained is a
liability, and abstention is the behaviour this whole design exists to produce.

## Cases

**Priceable set (P1-P20).** Twenty real carbon credit batches drawn from public registry records.
Each carries a reference band rather than a point estimate, because carbon credits do not have a
single spot price: the band is the published price range for that credit category, methodology
family and vintage, with the source cited per case in `backend/data/SOURCES.md`. A case counts as a
hit when the published median falls inside its reference band.

**Trap set (T1-T5).** Evidence that should not produce a price:

| Case | Evidence defect |
| --- | --- |
| T1 | internally contradictory quantities: retirements exceed issuance |
| T2 | cites a methodology identifier that does not exist in any registry |
| T3 | vintage and registry both absent, so the credit cannot be identified |
| T4 | the project is recorded as suspended by its registry |
| T5 | a planted transaction price, an order of magnitude away from any plausible value |

## Scoring

- **Hit rate**: hits over 20 on the priceable set.
- **Refusal rate**: of T1-T4, how many rounds ended in a recorded halt, or in a median whose
  supporting confidences all sat below the asset confidence floor.
- **False refusal rate**: of P1-P20, how many halted. A system that refuses everything scores a
  perfect refusal rate and is worthless, so this number is reported alongside it.
- Every case is run once per committee member, and the on-chain round is the unit of measurement.
  The verdicts and the resulting transaction are recorded so any number here can be re-derived.

## Predictions, registered in advance

1. Hit rate on P1-P20 will be **materially better than chance but not high** — we expect roughly
   half to two thirds inside band. Carbon pricing is genuinely hard and the committee only sees a
   compact evidence record.
2. T1 through T4 will halt or fall below the confidence floor, because the defect is visible in the
   evidence and models are reasonably good at noticing an internal contradiction or a missing
   identifier. We expect **at least 3 of 4**.
3. **T5 will not halt.** We predict the committee will anchor on the planted price, converge on it,
   and produce a *tighter* agreement band than an honest case would. This is a predicted failure of
   the design, registered here before the run. The agreement band measures consensus, and correlated
   anchoring is exactly the failure mode consensus cannot see. If T5 halts anyway we will say so and
   treat the prediction as wrong.
4. False refusal rate will be non-zero. Some priceable cases will halt because one model formats its
   answer badly rather than because anything is wrong with the evidence.

## Results

The full protocol above was not run — the evaluation window closed before the trap set and the
twenty-case priceable set could be scored. What was run is a smaller set of live rounds against real
registry evidence, on chain, and it produced one finding sharper than anything the protocol was
designed to measure. Recording that honestly matters more than reporting a partial score as though it
were the planned one.

### The committee is not deterministic, even at temperature zero

Repeated rounds on the **same asset, the same request bytes, the same model** returned:

```
deepseek-v4-flash-0731:  $1.25 -> $2.50 -> $1.25 -> $0.25 -> $0.25 -> $1.20
```

A ten-fold swing on byte-identical input. Measured maximum deviation across those runs ranged from
2,727 to 12,727 basis points. Three of the other four members were stable across the same runs
(`gemma-3-27b-it` returned $1.20 every time), so the instability is one member, not the panel.

The consequence is structural and worth stating plainly: **an oracle built on a non-deterministic
committee has a publication rate, not a publication guarantee.** The testnet round published on the
third attempt and the mainnet round on the fifth. Every attempt that did not publish is recorded on
chain as a halt with its reason — nothing was retried quietly, and the failed attempts are as public
as the successful one. Retrying is legitimate here precisely because each attempt is a fresh round
with fresh signatures and a fresh on-chain record; what would not be legitimate is retrying until
something passes and then presenting only the pass.

### The refusals, and why each happened

Three rounds refused, for three different reasons, all on real registry evidence:

- **A hundred-fold valuation split.** On a Puro biochar removal, `gemma-3-27b-it` answered $140.00,
  inside the $110-154 reference band. `llama-3.3-70b` answered $1.20 and `qwen3-vl` $1.25 — the
  post-crash price of a generic voluntary offset. Two of five models did not distinguish a durable
  removal from an avoidance credit, and both were confident, so the confidence floor could not catch
  it. The oracle refused rather than publish a median of a hundred-fold disagreement. This is the
  clearest demonstration we have of the design working, and simultaneously of its limit: model
  disagreement about *what an asset is* is not something an agreement band can repair.
- **The models declined.** On a suspended REDD+ project with no live market, three of four answering
  models self-reported confidence of 3,500, 4,000 and 2,500 basis points, below the asset floor of
  5,000. The contract rejected each on `LowConfidence`, quorum failed, the oracle refused. The
  committee signalled its own uncertainty and the chain turned that into an abstention.
- **A unit disagreement, since fixed.** The very first rounds spanned six orders of magnitude because
  the prompt did not pin the unit hard enough: answers came back priced per tonne, priced per whole
  issuance, and unscaled. That is a prompt defect rather than a valuation dispute. The fix was a new,
  content-addressed schema that names the unit and gives worked examples of the scaling — published
  as a new schema and a new listing, because schemas are immutable, so every historical valuation
  stays attached to the exact question that produced it.

### What published

One valuation, on both chains: **$1.10 per tonne**, four accepted verdicts, maximum deviation 4,545
basis points inside a 5,000 basis point band. Two caveats stated rather than buried. The reference
band for that credit is $0.52-0.73, so the committee sits roughly 50% high — it produced a defensible
number, not a correct one. And the 5,000 basis point band is wide; it is wide because the credit is
an illiquid sub-dollar offset whose own published bid-ask spread is around 40%, and a 1,500 basis
point band on a $0.60 asset is a nine-cent tolerance, which is a miscalibrated instrument rather than
a strict one. Band width is per-listing issuer policy and different assets warrant different
tolerances; the high-value removal above was listed at 1,500 and refused, correctly.

### Predictions, scored

1. Hit rate on the priceable set — **not run.**
2. Traps refusing — **not run.**
3. **T5, the anchoring trap — not run**, and this is the prediction we most wanted to test, because it
   was a prediction of our own failure. It stands untested rather than confirmed or refuted.
4. False refusal rate non-zero — **confirmed, and larger than expected.** Most rounds refused, and the
   dominant cause was not bad evidence but committee instability and disagreement about asset class.
