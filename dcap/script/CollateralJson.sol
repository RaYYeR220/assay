// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {VmSafe} from "forge-std/Vm.sol";
import {Collateral} from "./CollateralUploader.sol";

/// @notice Reads `data/collateral/onchain.json` (produced by build_onchain_collateral.py)
///         and the raw quote hex, without depending on forge-std's Script/Test base.
library CollateralJson {
    VmSafe private constant vm = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    function load(string memory path) internal view returns (Collateral memory c, bytes6 fmspc, uint32 tcbEval) {
        string memory json = vm.readFile(path);

        c.rootCaDer = vm.parseJsonBytes(json, ".rootCaDer");
        c.rootCrlDer = vm.parseJsonBytes(json, ".rootCrlDer");
        c.tcbSigningDer = vm.parseJsonBytes(json, ".tcbSigningDer");
        c.pckCaDer = vm.parseJsonBytes(json, ".pckCaDer");
        c.pckCa = uint8(vm.parseJsonUint(json, ".pckCa"));
        c.pckCrlDer = vm.parseJsonBytes(json, ".pckCrlDer");
        c.tcbInfoStrs = vm.parseJsonStringArray(json, ".tcbInfoStrs");
        c.tcbInfoSigs = vm.parseJsonBytesArray(json, ".tcbInfoSigs");
        c.qeIdentityStr = vm.parseJsonString(json, ".qeIdentityStr");
        c.qeIdentitySig = vm.parseJsonBytes(json, ".qeIdentitySig");
        c.tcbEvalStr = vm.parseJsonString(json, ".tcbEvalStr");
        c.tcbEvalSig = vm.parseJsonBytes(json, ".tcbEvalSig");

        fmspc = bytes6(vm.parseJsonBytes(json, ".fmspc"));
        tcbEval = uint32(vm.parseJsonUint(json, ".tcbEvaluationDataNumber"));
    }

    /// @notice Loads a raw DCAP quote stored as a bare hex string (no 0x prefix).
    function loadQuote(string memory path) internal view returns (bytes memory) {
        string memory hexStr = vm.trim(vm.readFile(path));
        return vm.parseBytes(string.concat("0x", hexStr));
    }
}
