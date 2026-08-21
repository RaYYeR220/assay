// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {IQuoteAdapter} from "../src/interfaces/IQuoteAdapter.sol";

/// @notice Verifies real Intel TDX quotes on chain and registers the keys they carry.
/// @dev Two passes on purpose. The measurement an enclave reports is not known until its quote has
///      been verified, so the first pass runs the verifier without broadcasting to learn it, and
///      only then does the second pass allow that measurement and register the signer. The signing
///      address is never supplied by this script; it comes out of the verified report data.
///
///      Environment:
///        PRIVATE_KEY           registry owner
///        ATTESTATION_REGISTRY  deployed registry
///        QUOTES                path to the quote manifest (default ./data/quotes.json)
contract RegisterSigners is Script {
    struct Entry {
        string model;
        bytes quote;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        AttestationRegistry registry = AttestationRegistry(vm.envAddress("ATTESTATION_REGISTRY"));
        string memory path = vm.envOr("QUOTES", string("./data/quotes.json"));

        Entry[] memory entries =
            abi.decode(vm.parseJson(vm.readFile(path), ".entries"), (Entry[]));
        IQuoteAdapter adapter = registry.adapter();

        bytes32[] memory measurements = new bytes32[](entries.length);
        bool[] memory verified = new bool[](entries.length);

        for (uint256 i = 0; i < entries.length; ++i) {
            (bool ok, bytes32 measurement,, uint8 tcbStatus) = adapter.verifyQuote(entries[i].quote);
            measurements[i] = measurement;
            verified[i] = ok;
            console2.log(ok ? "verified  " : "REJECTED  ", entries[i].model, tcbStatus);
            if (ok) console2.logBytes32(measurement);
        }

        vm.startBroadcast(pk);

        for (uint256 i = 0; i < entries.length; ++i) {
            if (!verified[i]) continue;
            if (!registry.allowedImage(measurements[i])) {
                registry.setAllowedImage(measurements[i], true);
            }
            registry.registerSigner(entries[i].quote, entries[i].model);
        }

        vm.stopBroadcast();
    }
}
