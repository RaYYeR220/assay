// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {Schema} from "./Schema.sol";

/// @notice Exports the on-chain prompt fragments so off-chain clients can reproduce request bytes
///         exactly rather than re-typing them.
contract DumpSchema is Script {
    function run() external {
        string memory json = "schema";
        vm.serializeBytes32(json, "schemaId", Schema.id());
        vm.serializeBytes(json, "head", Schema.HEAD);
        vm.serializeBytes(json, "mid", Schema.MID);
        string memory out = vm.serializeBytes(json, "tail", Schema.TAIL);
        vm.writeJson(out, "./schema.appraisal.v1.json");
    }
}
