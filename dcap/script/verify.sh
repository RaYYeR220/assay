#!/usr/bin/env bash
# Verify every deployed contract on Sourcify (X Layer needs no API key).
#   ./script/verify.sh 1952        # testnet
#   ./script/verify.sh 196         # mainnet
set -euo pipefail
CHAIN_ID="${1:?usage: verify.sh <chain-id>}"
DEPLOY="deployments/${CHAIN_ID}.json"
[ -f "$DEPLOY" ] || { echo "no $DEPLOY"; exit 1; }

declare -A SRC=(
  [EnclaveIdentityHelper]="lib/automata-on-chain-pccs/src/helpers/EnclaveIdentityHelper.sol:EnclaveIdentityHelper"
  [FmspcTcbHelper]="lib/automata-on-chain-pccs/src/helpers/FmspcTcbHelper.sol:FmspcTcbHelper"
  [PCKHelper]="lib/automata-on-chain-pccs/src/helpers/PCKHelper.sol:PCKHelper"
  [X509CRLHelper]="lib/automata-on-chain-pccs/src/helpers/X509CRLHelper.sol:X509CRLHelper"
  [TcbEvalHelper]="lib/automata-on-chain-pccs/src/helpers/TcbEvalHelper.sol:TcbEvalHelper"
  [AutomataDaoStorage]="lib/automata-on-chain-pccs/src/automata_pccs/shared/AutomataDaoStorage.sol:AutomataDaoStorage"
  [PccsDependencyConfig]="lib/automata-on-chain-pccs/src/automata_pccs/shared/PccsDependencyConfig.sol:PccsDependencyConfig"
  [AutomataPcsDao]="lib/automata-on-chain-pccs/src/automata_pccs/AutomataPcsDao.sol:AutomataPcsDao"
  [AutomataPckDao]="lib/automata-on-chain-pccs/src/automata_pccs/AutomataPckDao.sol:AutomataPckDao"
  [AutomataTcbEvalDao]="lib/automata-on-chain-pccs/src/automata_pccs/AutomataTcbEvalDao.sol:AutomataTcbEvalDao"
  [AutomataEnclaveIdentityDaoVersioned]="lib/automata-on-chain-pccs/src/automata_pccs/versioned/AutomataEnclaveIdentityDaoVersioned.sol:AutomataEnclaveIdentityDaoVersioned"
  [AutomataFmspcTcbDaoVersioned]="lib/automata-on-chain-pccs/src/automata_pccs/versioned/AutomataFmspcTcbDaoVersioned.sol:AutomataFmspcTcbDaoVersioned"
  [PCCSRouter]="lib/automata-dcap-attestation/evm/contracts/PCCSRouter.sol:PCCSRouter"
  [V4QuoteVerifier]="lib/automata-dcap-attestation/evm/contracts/verifiers/V4QuoteVerifier.sol:V4QuoteVerifier"
  [AutomataDcapAttestationFee]="lib/automata-dcap-attestation/evm/contracts/AutomataDcapAttestationFee.sol:AutomataDcapAttestationFee"
)

for name in "${!SRC[@]}"; do
  addr=$(python -c "import json,sys;print(json.load(open('$DEPLOY')).get('$name',''))")
  [ -n "$addr" ] || continue
  echo "== $name $addr"
  forge verify-contract --chain-id "$CHAIN_ID" --verifier sourcify "$addr" "${SRC[$name]}" || echo "   (failed, continuing)"
done
