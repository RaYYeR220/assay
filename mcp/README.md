# @assay/mcp

An MCP server over **Assay**, the NAV oracle on OKX X Layer for real-world assets nobody can
price. It lets an agent consult the oracle directly — and, just as importantly, lets it see
when the oracle is refusing to answer and why.

Five language models running in Intel TDX enclaves appraise the asset. The contract
re-verifies each attestation on chain, rebuilds the exact request and response bytes, checks
the enclave signature, parses the answer under a strict grammar, and publishes a price only
if a quorum agrees within a band on fresh evidence. Otherwise it records a HALT and every
consumer is frozen.

## Every tool is read-only

No tool in this server holds a private key, signs a message, or sends a transaction. There
is no configuration that enables one. The underlying client is constructed without a wallet,
so the capability is absent rather than disabled.

That is a deliberate boundary. An agent that can consult a price oracle and an agent that can
move value against it are two different trust decisions, and a server that quietly does both
takes the second one away from whoever installed it. If you want an agent to post an
appraisal, challenge a price, or subscribe to a vault, use `@assay/sdk` in code you control,
where the key is yours and the transaction is explicit.

The corollary: when the oracle refuses, that refusal comes back as **data**, not as a thrown
tool error. A halted oracle is the system working. A tool that threw would invite the model to
retry, work around it, or fill the gap with a number of its own — which is precisely the
failure Assay exists to prevent.

## Install

```bash
pnpm add -g @assay/mcp
```

Or run it from a checkout. The server depends on `@assay/sdk`, so build that first:

```bash
cd assay/sdk && pnpm install && pnpm build
cd ../mcp && pnpm install && pnpm build
```

## Client configuration

Add this to your MCP client's server config (`claude_desktop_config.json`, `.mcp.json`, or
whatever your client uses):

```json
{
  "mcpServers": {
    "assay": {
      "command": "npx",
      "args": ["-y", "@assay/mcp"],
      "env": {
        "ASSAY_CHAIN_ID": "196"
      }
    }
  }
}
```

From a local checkout, point at the built entry point instead:

```json
{
  "mcpServers": {
    "assay": {
      "command": "node",
      "args": ["/absolute/path/to/assay/mcp/dist/index.js"],
      "env": {
        "ASSAY_CHAIN_ID": "196",
        "ASSAY_DEPLOYMENTS_DIR": "/absolute/path/to/assay/deployments"
      }
    }
  }
}
```

In Claude Code: `claude mcp add assay -- node /absolute/path/to/assay/mcp/dist/index.js`

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ASSAY_CHAIN_ID` | `196` | 196 for X Layer, 1952 for X Layer testnet. |
| `ASSAY_RPC_URL` | the chain's public RPC | Override the endpoint. |
| `ASSAY_DEPLOYMENTS_DIR` | searched upward from cwd | Directory holding `<chainId>.json`. |
| `ASSAY_ORACLE` | from the deployment file | Override the oracle address. |
| `ASSAY_ASSET_REGISTRY` | from the deployment file | Override the registry address. |
| `ASSAY_ATTESTATION_REGISTRY` | from the deployment file | Override the attestation registry. |
| `ASSAY_VAULT` | from the deployment file | Default vault for `check_vault`. |
| `ASSAY_FROM_BLOCK` | `0` | First block for log scans. Set it on a busy chain. |

When no address can be resolved, tools return `{"ok": false, "reason": "not-configured"}` with
the variables to set. They do not guess.

## Tools

### `list_assets`
Every listed asset with the policy it is priced under: the committee of models seated on it,
how many must agree, how tightly, how fresh their answers must be, the confidence floor, and
what challenging the price costs. Includes whether a usable price exists right now.

### `get_nav`
The attested unit price in US dollars, or a structured refusal. A refusal names the reason
(`halted`, `stale`, `disputed`, `no-nav`, `sequencer-down`) and explains it in a sentence.
When a halted asset still has a last-known value it is returned clearly labelled as not a
price, so a model reading the output cannot mistake it for one.

### `explain_round`
The audit trail for a round. For each committee seat: the model, the value it returned, its
own confidence, how far it sat from the median, and the enclave key that signed it — or, when
it was thrown out, the contract's own rejection reason and what that reason means. Then the
median, the band, the quorum, and how the round ended. Defaults to the most recent epoch.

### `get_attestations`
Registered enclave keys with the measurement of the image they run, Intel TCB status, expiry,
the models they may answer for, and the transaction where each TDX quote was verified on
chain. None of these keys was named by an operator: each was read out of the `report_data` of
a quote the registry verified against the Intel root of trust.

### `verify_bundle`
Given evidence and a set of responses with signatures, re-run the whole verification locally
and report per-member pass or fail with reasons. It rebuilds the request bytes from the
prompt fragments, hashes both bodies, reconstructs the 129-character text the enclave signed,
recovers the key, parses under the contract's strict grammar, applies the confidence floor and
freshness window, and then applies quorum, distinct-signer and band rules to the round. It
says whether the oracle would publish, and if not, which halt it would record. Nothing is
sent to the chain; with `schema` and `policy` supplied it does not even need one.

### `check_vault`
Share price, supply, liquidity, and whether subscribing or redeeming is possible right now.
When the oracle refuses, the vault refuses too — there is no cached price and no operator
override — and this tool reports that as a `frozen` field rather than as an outage.

## What the agent should do with a refusal

Report it. The reason is the information: `halted` with `Disagreement` means five independent
appraisers looked at the same evidence and could not agree within the band the issuer chose,
which is a fact about the asset, not about the oracle. Do not substitute an estimate, and do
not reach for a price from somewhere else and present it as the NAV.

## Development

```bash
pnpm install
pnpm test        # in-process client over an in-memory transport
pnpm build
pnpm dev         # run from source over stdio
pnpm relink      # after rebuilding @assay/sdk: pnpm copies file: dependencies at install time
```

`pnpm test` asserts, among other things, that every advertised tool is annotated read-only
and that the tool surface mentions no key material.
