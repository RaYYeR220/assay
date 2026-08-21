// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssayVault} from "../src/AssayVault.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AutomataTdxAdapter, IDcapAttestation} from "../src/adapters/AutomataTdxAdapter.sol";
import {UnverifiedQuoteAdapter} from "../src/adapters/UnverifiedQuoteAdapter.sol";
import {DemoUSD} from "../src/demo/DemoUSD.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IAssayOracle} from "../src/interfaces/IAssayOracle.sol";
import {IQuoteAdapter} from "../src/interfaces/IQuoteAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AssetConfig} from "../src/Types.sol";
import {Schema} from "./Schema.sol";

/// @notice Deploys the protocol and lists the first carbon-credit asset.
/// @dev Environment:
///      PRIVATE_KEY      deployer key
///      DCAP_ATTESTATION address of the on-chain Intel DCAP verifier; an adapter is deployed for it
///      QUOTE_ADAPTER    an already-deployed adapter, if you have one, taking precedence over the above
///      TCB_EVAL         Intel TCB evaluation number the collateral was uploaded under (default 20)
///
///      With neither DCAP_ATTESTATION nor QUOTE_ADAPTER set, a clearly-labelled non-verifying
///      stand-in is deployed, which is only ever acceptable on a throwaway network.
///      CURRENCY         settlement token; when unset a six-decimal demo token is deployed
///      SEQUENCER_FEED   Chainlink L2 uptime feed; skipped when unset
///      ASSET_KEY        string identifying the listed asset, hashed into the asset id
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address adapterAddr = vm.envOr("QUOTE_ADAPTER", address(0));
        address currencyAddr = vm.envOr("CURRENCY", address(0));
        address sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));
        string memory assetKey = vm.envOr("ASSET_KEY", string("assay.carbon.demo.v1"));
        bytes32 assetId = keccak256(bytes(assetKey));
        bytes32 fleetAssetId;

        vm.startBroadcast(pk);

        address dcap = vm.envOr("DCAP_ATTESTATION", address(0));
        if (adapterAddr == address(0) && dcap != address(0)) {
            adapterAddr = address(
                new AutomataTdxAdapter(IDcapAttestation(dcap), uint8(vm.envOr("TCB_EVAL", uint256(20))))
            );
        }
        if (adapterAddr == address(0)) {
            adapterAddr = address(new UnverifiedQuoteAdapter(deployer));
            console2.log("WARNING: deployed a non-verifying quote adapter stand-in");
        }
        if (currencyAddr == address(0)) {
            currencyAddr = address(new DemoUSD());
        }

        AttestationRegistry attestations = new AttestationRegistry(IQuoteAdapter(adapterAddr), deployer);
        AssetRegistry assets = new AssetRegistry();
        AssayOracle oracle = new AssayOracle(assets, attestations, deployer);

        if (sequencerFeed != address(0)) {
            oracle.setSequencerFeed(IAggregatorV3(sequencerFeed), 30 minutes);
        }

        bytes32 schemaId = assets.registerSchema(Schema.HEAD, Schema.MID, Schema.TAIL);

        // One attested gateway enclave fronts all five models, so only one distinct signer is
        // available on this committee. The threshold is set to what is actually true rather than to
        // what sounds better; the second listing below is where the signer axis is exercised.
        assets.registerAsset(
            assetId,
            AssetConfig({
                issuer: deployer,
                quorum: 3,
                minDistinctSigners: 1,
                bandBps: 1000,
                minConfidenceBps: 5000,
                maxAgeSec: 3600,
                disputeBandBps: 500,
                disputeBond: 0.01 ether,
                schemaId: schemaId,
                active: true,
                requireAllowedEvidence: false
            }),
            _modelDiverseCommittee(),
            "ipfs://assay/carbon/demo"
        );

        fleetAssetId = keccak256(bytes(string.concat(assetKey, ".fleet")));
        assets.registerAsset(
            fleetAssetId,
            AssetConfig({
                issuer: deployer,
                quorum: 3,
                minDistinctSigners: 3,
                bandBps: 1000,
                minConfidenceBps: 5000,
                maxAgeSec: 3600,
                disputeBandBps: 500,
                disputeBond: 0.01 ether,
                schemaId: schemaId,
                active: true,
                requireAllowedEvidence: false
            }),
            _enclaveDiverseCommittee(),
            "ipfs://assay/carbon/fleet"
        );

        AssayVault vault = new AssayVault(
            "Assay Carbon Basket",
            "aCARB",
            IERC20(currencyAddr),
            6,
            IAssayOracle(address(oracle)),
            assetId,
            deployer,
            0
        );

        vm.stopBroadcast();

        console2.log("chainId           ", block.chainid);
        console2.log("deployer          ", deployer);
        console2.log("quoteAdapter      ", adapterAddr);
        console2.log("attestationRegistry", address(attestations));
        console2.log("assetRegistry     ", address(assets));
        console2.log("assayOracle       ", address(oracle));
        console2.log("assayVault        ", address(vault));
        console2.log("currency          ", currencyAddr);
        console2.logBytes32(assetId);
        console2.logBytes32(fleetAssetId);

        _writeDeployment(adapterAddr, address(attestations), address(assets), address(oracle), address(vault), currencyAddr, assetId, assetKey);
    }

    /// @dev Five model families from five different vendors, so a shared failure mode in any one of
    ///      them cannot carry a round on its own. Model identity is bound into the signed request,
    ///      because the contract rebuilds that request with the slot model id before checking the
    ///      signature, so this diversity is enforced rather than advertised.
    function _modelDiverseCommittee() internal pure returns (string[] memory c) {
        c = new string[](5);
        c[0] = "deepseek/deepseek-v4-flash-0731";
        c[1] = "openai/gpt-oss-120b";
        c[2] = "meta-llama/llama-3.3-70b-instruct";
        c[3] = "qwen/qwen3.6-27b";
        c[4] = "z-ai/glm-5.2";
    }

    /// @dev The other axis. Every slot is the same model, served by a fleet of separate trust
    ///      domains, each with its own attested key. Diversity here is in the enclaves rather than
    ///      the models, and `minDistinctSigners` is what forces it: three slots filled from one
    ///      enclave will not reach the threshold no matter how well the answers agree.
    function _enclaveDiverseCommittee() internal pure returns (string[] memory c) {
        c = new string[](5);
        for (uint256 i = 0; i < 5; ++i) {
            c[i] = "moonshotai/kimi-k2.6";
        }
    }

    function _writeDeployment(
        address adapter,
        address attestations,
        address assets,
        address oracle,
        address vault,
        address currency,
        bytes32 assetId,
        string memory assetKey
    ) internal {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "quoteAdapter", adapter);
        vm.serializeAddress(json, "attestationRegistry", attestations);
        vm.serializeAddress(json, "assetRegistry", assets);
        vm.serializeAddress(json, "assayOracle", oracle);
        vm.serializeAddress(json, "assayVault", vault);
        vm.serializeAddress(json, "currency", currency);
        vm.serializeString(json, "assetKey", assetKey);
        string memory out = vm.serializeBytes32(json, "assetId", assetId);
        vm.writeJson(out, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
    }
}
