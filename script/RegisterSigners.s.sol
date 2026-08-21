// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IQuoteAdapter} from "../src/interfaces/IQuoteAdapter.sol";

/// @notice Verifies real Intel TDX quotes on chain and registers the keys they carry.
/// @dev Two passes on purpose. The measurement an enclave reports is not known until its quote has
///      been verified, so the first pass runs the verifier without broadcasting to learn it, and
///      only then does the second pass register the signer. The signing address is never supplied
///      here; it comes out of the verified report data.
///
///      Measurements are NOT allowlisted automatically. An allowlist that accepts whatever the
///      quote happens to report is not an allowlist, so the manifest has to name the measurement
///      each entry is expected to produce, and a mismatch aborts. Run once with
///      `ALLOW_NEW_MEASUREMENTS=true` to discover them, read what it prints, then record them.
///
///      Environment:
///        PRIVATE_KEY             registry owner
///        ATTESTATION_REGISTRY    deployed registry
///        QUOTES                  quote manifest (default ./data/quotes.json)
///        ALLOW_NEW_MEASUREMENTS  discovery mode; never use for a real deployment
contract RegisterSigners is Script {
    error MeasurementMismatch(uint256 index, bytes32 expected, bytes32 actual);
    error MeasurementNotDeclared(uint256 index, bytes32 actual);

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        AttestationRegistry registry = AttestationRegistry(vm.envAddress("ATTESTATION_REGISTRY"));
        string memory json = vm.readFile(vm.envOr("QUOTES", string("./data/quotes.json")));
        bool discovery = vm.envOr("ALLOW_NEW_MEASUREMENTS", false);

        uint256 count = vm.parseJsonUint(json, ".count");
        IQuoteAdapter adapter = registry.adapter();

        bytes32[] memory measurements = new bytes32[](count);
        string[] memory models = new string[](count);
        bytes[] memory quotes = new bytes[](count);
        bool[] memory ok = new bool[](count);

        for (uint256 i = 0; i < count; ++i) {
            string memory at = string.concat(".entries[", vm.toString(i), "]");
            models[i] = vm.parseJsonString(json, string.concat(at, ".model"));
            quotes[i] = vm.parseJsonBytes(json, string.concat(at, ".quote"));

            uint8 tcbStatus;
            (ok[i], measurements[i],, tcbStatus) = adapter.verifyQuote(quotes[i]);
            console2.log(ok[i] ? "verified" : "REJECTED", models[i], tcbStatus);
            console2.logBytes32(measurements[i]);
            if (!ok[i]) continue;

            string memory key = string.concat(at, ".measurement");
            if (vm.keyExists(json, key)) {
                bytes32 declared = vm.parseJsonBytes32(json, key);
                if (declared != measurements[i]) {
                    revert MeasurementMismatch(i, declared, measurements[i]);
                }
            } else if (!discovery) {
                revert MeasurementNotDeclared(i, measurements[i]);
            }
        }

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < count; ++i) {
            if (!ok[i]) continue;
            if (!registry.allowedImage(measurements[i])) {
                registry.setAllowedImage(measurements[i], true);
            }
            registry.registerSigner(quotes[i], models[i]);
        }
        vm.stopBroadcast();
    }
}
