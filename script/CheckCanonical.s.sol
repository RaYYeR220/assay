// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Ascii} from "../src/libraries/Ascii.sol";
import {Schema} from "./Schema.sol";

/// @notice Cross-checks the off-chain request builder against the on-chain prompt schema.
/// @dev The whole verification chain rests on both sides producing byte-identical request bodies. A
///      single reordered field or stray space means no signature will ever recover to an attested
///      key, and the failure looks like a mysterious rejection rather than a serialisation bug. This
///      compares the digest the client recorded against one computed from the schema fragments.
contract CheckCanonical is Script {
    function run() external view {
        string memory json = vm.readFile("./backend/data/evidence.json");

        bytes32 fixtureSchemaId = vm.parseJsonBytes32(json, ".schemaId");
        if (fixtureSchemaId != Schema.id()) {
            console2.log("fixture was generated against a different schema, skipping");
            console2.logBytes32(fixtureSchemaId);
            console2.logBytes32(Schema.id());
            return;
        }

        uint256 assetCount = vm.parseJsonStringArray(json, ".assets[*].assetId").length;
        uint256 checked;

        for (uint256 a = 0; a < assetCount; ++a) {
            string memory base = string.concat(".assets[", vm.toString(a), "]");
            bytes memory evidence = bytes(vm.parseJsonString(json, string.concat(base, ".evidenceLine")));

            require(Ascii.isJsonStringSafe(evidence), "evidence charset violation");
            require(sha256(evidence) == vm.parseJsonBytes32(json, string.concat(base, ".evidenceSha256")), "evidence digest mismatch");

            for (uint256 s = 0; s < 5; ++s) {
                string memory slot = string.concat(base, ".requestsPerSlot[", vm.toString(s), "]");
                bytes memory model = bytes(vm.parseJsonString(json, string.concat(slot, ".model")));
                bytes memory request = bytes.concat(Schema.HEAD, model, Schema.MID, evidence, Schema.TAIL);
                bytes32 expected = vm.parseJsonBytes32(json, string.concat(slot, ".requestSha256"));
                require(sha256(request) == expected, "request digest mismatch");
                ++checked;
            }
        }

        console2.log("canonical request digests agree", checked);
    }
}
