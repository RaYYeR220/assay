# Integrating Assay on chain

Assay prices assets that no feed covers. The interesting part of the integration is not
reading the price — it is what happens when there isn't one.

## The three-line consumer

```solidity
import {IAssayOracle} from "@assay/sdk/solidity/IAssayOracle.sol";

contract Lending {
    IAssayOracle constant ORACLE = IAssayOracle(0x0000000000000000000000000000000000000000);
    bytes32 constant CARBON = keccak256("assay.carbon.demo.v1");

    function collateralValue(uint256 units) public view returns (uint256) {
        uint256 navE6 = ORACLE.requireFreshNav(CARBON); // reverts unless a quorum agreed, recently
        return units * navE6 / 1e6;
    }
}
```

That is the whole pattern. `requireFreshNav` reverts when the committee failed to reach
quorum, when it reached quorum but disagreed by more than the asset's band, when the price
aged out of its freshness window, while a challenge is open, and when the L2 sequencer is
not reliably up. Let it revert. Every caller above you stops, which is the point.

## What not to do

```solidity
// Do not do this.
try ORACLE.requireFreshNav(assetId) returns (uint256 navE6) {
    lastGood = navE6;
} catch {
    navE6 = lastGood; // you have just re-introduced the failure the oracle exists to prevent
}
```

A cached fallback turns a refusal into a stale price at exactly the moment the appraisal
process said the price was not knowable. If your protocol genuinely cannot revert, pause
instead: freeze the position, do not value it at a number nobody attested to.

## Displaying state without moving value

User interfaces and keepers should read `peekNav`, which never reverts:

```solidity
(Nav memory nav, bool usable) = ORACLE.peekNav(assetId);
if (!usable) {
    // nav.state distinguishes Empty / Halted / Disputed / Voided; show it verbatim
}
```

`usable` is true only when `requireFreshNav` would return, so the two never disagree.

## Units

`valueE6` is US dollars per **one unit** of the asset, scaled by 1e6. A carbon credit worth
$4.21 is `4_210_000`. Rescale once, at the boundary of your accounting, and keep the rest of
your maths in your own units — `AssayVault` does exactly this and is worth reading as a
worked example.

## Choosing an asset id

The asset id is whatever the issuer chose when they listed it, conventionally
`keccak256(bytes(assetKey))`. Read it from `deployments/<chainId>.json`, or enumerate the
registry with `assetCount()` / `assetAt(i)`. Do not derive it yourself from a name you were
told: an id that does not exist reverts with `UnknownAsset`, but an id that exists and
belongs to a different asset does not.

## Before you deploy

Run `assay-verify --chain <id>` from the SDK. It re-derives every claim about the deployment
from public data: that the contracts are where the deployment file says, that the attestation
adapter is a real on-chain DCAP verifier rather than the development stand-in, that each
registered enclave key matches the key the live enclave binds into its own TDX quote, and
that each published NAV really is the median of the verdicts the contract accepted. It holds
no key and sends no transaction.

## Listing an asset

Two steps, not one. Register the asset, then commit each evidence document before a round
prices against it:

```ts
await assay.commitEvidence(assetId, assay.evidenceHash(evidence), 'ipfs://...', true);
```

The oracle rejects a round whose evidence the issuer never stood behind. That splits the three
roles apart: the issuer commits to what the facts are, the committee decides what they are
worth, and the chain checks both. Skip it and whoever relays the round also chooses the facts.

## Errors, by name

| Error | What it means for you |
| --- | --- |
| `OracleHalted(assetId, reason)` | The last round published nothing. `reason` distinguishes an incomplete quorum from a disagreement, an unhealthy sequencer, a delisted asset, or a round that carried too few authentic signatures. |
| `NavStale(assetId, observedAt)` | A price exists but is older than `maxAgeSec`. The committee has not been re-run. |
| `NavDisputed(assetId)` | Someone bonded a challenge. Consumers are frozen before anyone adjudicates it, deliberately. |
| `NoNav(assetId)` | The asset is listed but has never had a successful round. |
| `SequencerDown()` | The uptime feed says the sequencer is down, or has not been back up long enough. |
| `EvidenceNotCommitted(hash)` | You posted a round on a document the issuer never committed to. The most common integration mistake by a distance. |

Off chain, `explainRevert(error)` from `@assay/sdk` turns any of these into
`{ reason, detail }` without you decoding a selector.
