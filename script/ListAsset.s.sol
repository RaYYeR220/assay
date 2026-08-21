// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AssetConfig} from "../src/Types.sol";
import {Schema} from "./Schema.sol";

/// @notice Registers the current prompt schema and lists an asset against it.
/// @dev Schemas are content-addressed and immutable, so revising the prompt means publishing a new
///      one and listing a new asset rather than editing anything in place. That is the intended
///      shape: every historical valuation stays attached to the exact question that produced it.
contract ListAsset is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        AssetRegistry assets = AssetRegistry(vm.envAddress("ASSET_REGISTRY"));
        string memory assetKey = vm.envString("ASSET_KEY");
        bytes32 assetId = keccak256(bytes(assetKey));

        vm.startBroadcast(pk);

        bytes32 schemaId = Schema.id();
        if (!_exists(assets, schemaId)) {
            schemaId = assets.registerSchema(Schema.HEAD, Schema.MID, Schema.TAIL);
        }

        string[] memory committee = new string[](5);
        committee[0] = "deepseek/deepseek-v4-flash-0731";
        committee[1] = "google/gemma-3-27b-it";
        committee[2] = "meta-llama/llama-3.3-70b-instruct";
        committee[3] = "qwen/qwen-2.5-7b-instruct";
        committee[4] = "qwen/qwen3-vl-30b-a3b-instruct";

        assets.registerAsset(
            assetId,
            AssetConfig({
                issuer: vm.addr(pk),
                quorum: 3,
                minDistinctSigners: 1,
                bandBps: uint16(vm.envOr("BAND_BPS", uint256(1500))),
                minConfidenceBps: 5000,
                maxAgeSec: 3600,
                disputeBandBps: 500,
                disputeBond: 0.001 ether,
                schemaId: schemaId,
                active: true
            }),
            committee,
            vm.envOr("ASSET_URI", string("ipfs://assay/carbon"))
        );

        vm.stopBroadcast();

        console2.log("assetKey", assetKey);
        console2.logBytes32(assetId);
        console2.logBytes32(schemaId);
    }

    function _exists(AssetRegistry assets, bytes32 schemaId) internal view returns (bool) {
        try assets.schema(schemaId) returns (AssetRegistry.PromptSchema memory) {
            return true;
        } catch {
            return false;
        }
    }
}
