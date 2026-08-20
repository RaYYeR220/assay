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

Not yet run. Results, the per-case table, and the on-chain transaction for each round will be filled
in here, including whichever predictions turned out to be wrong.
