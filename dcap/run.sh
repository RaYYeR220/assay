#!/usr/bin/env bash
# Automata on-chain DCAP (Intel TDX) on OKX X Layer.
# Portable equivalent of the Makefile -- `make` is not on PATH on Windows/Git Bash.
#
#   ./run.sh fork-test                  # full pipeline on a fork of X Layer testnet, no funds needed
#   ./run.sh anvil                      # start a local anvil fork (leave running)
#   ./run.sh deploy-local               # deploy + upload + verify against that anvil
#   ./run.sh deploy-testnet 0x<pk>      # X Layer testnet, chainId 1952
#   ./run.sh deploy-mainnet 0x<pk>      # X Layer mainnet, chainId 196
#   ./run.sh verify-quote  <rpc> 0x<pk> # re-run just the on-chain verification
#   ./run.sh refresh                    # refetch quotes + Intel collateral
#   ./run.sh sourcify 1952              # source-verify the deployment
set -euo pipefail
cd "$(dirname "$0")"

RPC_TESTNET="${RPC_TESTNET:-https://testrpc.xlayer.tech}"
RPC_MAINNET="${RPC_MAINNET:-https://rpc.xlayer.tech}"
RPC_LOCAL="${RPC_LOCAL:-http://127.0.0.1:8545}"
# anvil's first default account
ANVIL_PK="${ANVIL_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

deploy_all() {
  local rpc="$1" pk="$2"
  mkdir -p deployments
  echo "### 1/3 deploy stack -> $rpc"
  forge script script/Deploy.s.sol:Deploy --rpc-url "$rpc" --private-key "$pk" --broadcast --slow -vv
  echo "### 2/3 upload Intel collateral"
  forge script script/Deploy.s.sol:UploadCollateral --rpc-url "$rpc" --private-key "$pk" --broadcast --slow -vv
  echo "### 3/3 verify a real Phala TDX quote on-chain"
  forge script script/Deploy.s.sol:VerifyQuote --rpc-url "$rpc" --private-key "$pk" --broadcast -vv
}

cmd="${1:-fork-test}"
case "$cmd" in
  build)        forge build ;;

  fork-test)
    EXPECTED_SIGNING_ADDRESS=0x79a5061efe5a46b0d1f33b11cf1c5adbedae6b79 \
      forge test --match-path test/XLayerForkE2E.t.sol -vv
    ;;

  anvil)
    # --hardfork osaka is what exposes P256VERIFY at 0x100 locally (see README section 3)
    exec anvil --fork-url "$RPC_TESTNET" --chain-id 1952 --hardfork osaka --gas-limit 210000000
    ;;

  deploy-local)   deploy_all "$RPC_LOCAL"   "$ANVIL_PK" ;;
  deploy-testnet) deploy_all "$RPC_TESTNET" "${2:?usage: run.sh deploy-testnet 0x<private-key>}" ;;
  deploy-mainnet) deploy_all "$RPC_MAINNET" "${2:?usage: run.sh deploy-mainnet 0x<private-key>}" ;;

  verify-quote)
    forge script script/Deploy.s.sol:VerifyQuote \
      --rpc-url "${2:?usage: run.sh verify-quote <rpc> 0x<pk>}" \
      --private-key "${3:?usage: run.sh verify-quote <rpc> 0x<pk>}" --broadcast -vv
    ;;

  refresh)
    python data/fetch_all.py
    python data/build_onchain_collateral.py
    ;;

  sourcify)     ./script/verify.sh "${2:?usage: run.sh sourcify <chain-id>}" ;;

  *) echo "unknown command: $cmd"; sed -n '3,14p' "$0"; exit 1 ;;
esac
