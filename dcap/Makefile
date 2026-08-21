# Automata on-chain DCAP (Intel TDX) on OKX X Layer
#
#   make fork-test                 # full pipeline against a fork of X Layer testnet (no funds needed)
#   make anvil                     # start a local anvil fork (separate terminal)
#   make deploy-local              # deploy + upload + verify against that anvil
#   make deploy-testnet PK=0x..    # the real thing, X Layer testnet (chainId 1952)
#   make deploy-mainnet PK=0x..    # X Layer mainnet (chainId 196)
#
# Collateral is baked into data/collateral/onchain.json (make collateral to refresh).

RPC_TESTNET ?= https://testrpc.xlayer.tech
RPC_MAINNET ?= https://rpc.xlayer.tech
RPC_LOCAL   ?= http://127.0.0.1:8545
PK          ?=
QUOTE_PATH  ?= data/quote_deepseek_deepseek-v4-flash-0731.hex

# X Layer runs RIP-7212 P256VERIFY at 0x100 (3450 gas). Foundry's local EVM only exposes
# a P256 precompile at that address under the `osaka` spec (EIP-7951), so local runs need it.
LOCAL_EVM   :=

FORGE_AUTH = $(if $(PK),--private-key $(PK),--unlocked --sender $(OWNER))

.PHONY: build fork-test anvil deploy-local deploy-testnet deploy-mainnet refresh verify-contracts clean

build:
	forge build

## ---------- proof on a fork, needs no funded wallet ----------
fork-test:
	$(LOCAL_EVM) EXPECTED_SIGNING_ADDRESS=0x79a5061efe5a46b0d1f33b11cf1c5adbedae6b79 \
		forge test --match-path test/XLayerForkE2E.t.sol -vv

anvil:
	anvil --fork-url $(RPC_TESTNET) --chain-id 1952 --hardfork osaka --gas-limit 210000000

# anvil's first default account
ANVIL_PK ?= 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

deploy-local:
	$(LOCAL_EVM) PK=$(ANVIL_PK) $(MAKE) _deploy RPC=$(RPC_LOCAL) PK=$(ANVIL_PK)

deploy-testnet:
	$(MAKE) _deploy RPC=$(RPC_TESTNET) PK=$(PK)

deploy-mainnet:
	$(MAKE) _deploy RPC=$(RPC_MAINNET) PK=$(PK)

_deploy:
	@mkdir -p deployments
	forge script script/Deploy.s.sol:Deploy --rpc-url $(RPC) --private-key $(PK) --broadcast --slow -vv
	forge script script/Deploy.s.sol:UploadCollateral --rpc-url $(RPC) --private-key $(PK) --broadcast --slow -vv
	forge script script/Deploy.s.sol:VerifyQuote --rpc-url $(RPC) --private-key $(PK) --broadcast -vv

## ---------- data refresh ----------
refresh:
	python data/fetch_all.py
	python data/build_onchain_collateral.py

## ---------- source verification (sourcify, no API key) ----------
verify-contracts:
	./script/verify.sh $(CHAIN_ID)

clean:
	forge clean
