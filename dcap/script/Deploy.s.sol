// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Script, console} from "forge-std/Script.sol";

import {DcapStack, DcapAddresses} from "./DcapStack.sol";
import {CollateralUploader, Collateral} from "./CollateralUploader.sol";
import {CollateralJson} from "./CollateralJson.sol";
import {DcapOutput, TdxAttestationOutput} from "../src/DcapOutput.sol";

interface IDcap {
    function verifyAndAttestOnChain(bytes calldata rawQuote)
        external
        payable
        returns (bool success, bytes memory output);
    function verifyAndAttestOnChain(bytes calldata rawQuote, uint32 tcbEvaluationDataNumber)
        external
        payable
        returns (bool success, bytes memory output);
}

abstract contract DeploymentIO is Script {
    function _path() internal view returns (string memory) {
        return string.concat("deployments/", vm.toString(block.chainid), ".json");
    }

    function _write(DcapAddresses memory a) internal {
        string memory o = "dcap";
        vm.serializeAddress(o, "EnclaveIdentityHelper", a.enclaveIdHelper);
        vm.serializeAddress(o, "FmspcTcbHelper", a.fmspcTcbHelper);
        vm.serializeAddress(o, "PCKHelper", a.pckHelper);
        vm.serializeAddress(o, "X509CRLHelper", a.crlHelper);
        vm.serializeAddress(o, "TcbEvalHelper", a.tcbEvalHelper);
        vm.serializeAddress(o, "AutomataDaoStorage", a.daoStorage);
        vm.serializeAddress(o, "PccsDependencyConfig", a.depConfig);
        vm.serializeAddress(o, "AutomataPcsDao", a.pcsDao);
        vm.serializeAddress(o, "AutomataPckDao", a.pckDao);
        vm.serializeAddress(o, "AutomataTcbEvalDao", a.tcbEvalDao);
        vm.serializeAddress(o, "AutomataEnclaveIdentityDaoVersioned", a.enclaveIdDaoVersioned);
        vm.serializeAddress(o, "AutomataFmspcTcbDaoVersioned", a.fmspcTcbDaoVersioned);
        vm.serializeAddress(o, "PCCSRouter", a.router);
        vm.serializeAddress(o, "V4QuoteVerifier", a.v4Verifier);
        string memory json = vm.serializeAddress(o, "AutomataDcapAttestationFee", a.dcapAttestation);
        vm.writeJson(json, _path());
        console.log("wrote", _path());
    }

    function _read() internal view returns (DcapAddresses memory a) {
        string memory j = vm.readFile(_path());
        a.enclaveIdHelper = vm.parseJsonAddress(j, ".EnclaveIdentityHelper");
        a.fmspcTcbHelper = vm.parseJsonAddress(j, ".FmspcTcbHelper");
        a.pckHelper = vm.parseJsonAddress(j, ".PCKHelper");
        a.crlHelper = vm.parseJsonAddress(j, ".X509CRLHelper");
        a.tcbEvalHelper = vm.parseJsonAddress(j, ".TcbEvalHelper");
        a.daoStorage = vm.parseJsonAddress(j, ".AutomataDaoStorage");
        a.depConfig = vm.parseJsonAddress(j, ".PccsDependencyConfig");
        a.pcsDao = vm.parseJsonAddress(j, ".AutomataPcsDao");
        a.pckDao = vm.parseJsonAddress(j, ".AutomataPckDao");
        a.tcbEvalDao = vm.parseJsonAddress(j, ".AutomataTcbEvalDao");
        a.enclaveIdDaoVersioned = vm.parseJsonAddress(j, ".AutomataEnclaveIdentityDaoVersioned");
        a.fmspcTcbDaoVersioned = vm.parseJsonAddress(j, ".AutomataFmspcTcbDaoVersioned");
        a.router = vm.parseJsonAddress(j, ".PCCSRouter");
        a.v4Verifier = vm.parseJsonAddress(j, ".V4QuoteVerifier");
        a.dcapAttestation = vm.parseJsonAddress(j, ".AutomataDcapAttestationFee");
    }

    function _log(DcapAddresses memory a) internal pure {
        console.log("EnclaveIdentityHelper              ", a.enclaveIdHelper);
        console.log("FmspcTcbHelper                     ", a.fmspcTcbHelper);
        console.log("PCKHelper                          ", a.pckHelper);
        console.log("X509CRLHelper                      ", a.crlHelper);
        console.log("TcbEvalHelper                      ", a.tcbEvalHelper);
        console.log("AutomataDaoStorage                 ", a.daoStorage);
        console.log("PccsDependencyConfig               ", a.depConfig);
        console.log("AutomataPcsDao                     ", a.pcsDao);
        console.log("AutomataPckDao                     ", a.pckDao);
        console.log("AutomataTcbEvalDao                 ", a.tcbEvalDao);
        console.log("AutomataEnclaveIdentityDaoVersioned", a.enclaveIdDaoVersioned);
        console.log("AutomataFmspcTcbDaoVersioned       ", a.fmspcTcbDaoVersioned);
        console.log("PCCSRouter                         ", a.router);
        console.log("V4QuoteVerifier                    ", a.v4Verifier);
        console.log("AutomataDcapAttestationFee         ", a.dcapAttestation);
    }
}

/// @notice Step 1 - deploy the whole PCCS + DCAP stack.
/// forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --private-key $PK --broadcast
contract Deploy is DeploymentIO, DcapStack {
    function run() public {
        (, bytes6 fmspc, uint32 tcbEval) = CollateralJson.load("data/collateral/onchain.json");
        fmspc; // silence

        address owner = vm.envOr("OWNER", msg.sender);
        address p256 = vm.envOr("P256_VERIFIER", RIP7212_P256);
        bool withV3 = vm.envOr("WITH_V3", false);
        console.log("owner:", owner);
        console.log("P256 verifier:", p256);
        console.log("TCB evaluation data number:", tcbEval);

        vm.startBroadcast();
        DcapAddresses memory a = _deployAll(owner, p256, tcbEval, withV3);
        vm.stopBroadcast();

        _log(a);
        _write(a);
    }
}

/// @notice Step 2 - push the Intel collateral for our FMSPC(s) into on-chain PCCS.
/// forge script script/Deploy.s.sol:UploadCollateral --rpc-url $RPC_URL --private-key $PK --broadcast
contract UploadCollateral is DeploymentIO, CollateralUploader {
    function run() public {
        DcapAddresses memory a = _read();
        (Collateral memory c,, uint32 tcbEval) = CollateralJson.load("data/collateral/onchain.json");
        console.log("uploading collateral for tcbEval", tcbEval, "tcbInfos:", c.tcbInfoStrs.length);

        vm.startBroadcast();
        _uploadAll(a, c);
        vm.stopBroadcast();

        console.log("collateral uploaded");
    }
}

/// @notice Step 3 - prove it: verify a real Phala TDX quote on-chain and print the decoded output.
/// forge script script/Deploy.s.sol:VerifyQuote --rpc-url $RPC_URL --private-key $PK --broadcast
contract VerifyQuote is DeploymentIO {
    using DcapOutput for bytes;

    function run() public {
        DcapAddresses memory a = _read();
        (,, uint32 tcbEval) = CollateralJson.load("data/collateral/onchain.json");
        string memory quotePath =
            vm.envOr("QUOTE_PATH", string("data/quote_deepseek_deepseek-v4-flash-0731.hex"));
        bytes memory quote = CollateralJson.loadQuote(quotePath);
        console.log("quote:", quotePath, quote.length);

        vm.startBroadcast();
        (bool success, bytes memory output) = IDcap(a.dcapAttestation).verifyAndAttestOnChain(quote, tcbEval);
        vm.stopBroadcast();

        console.log("success:", success);
        if (!success) {
            console.log("reason:", string(output));
            revert("verification failed");
        }
        console.log("output length:", output.length);
        console.log("tcbStatus:", uint8(output[4]));
        console.logBytes(output);
    }

    /// @notice read-only variant (eth_call), no gas spent
    function simulate() public {
        DcapAddresses memory a = _read();
        (,, uint32 tcbEval) = CollateralJson.load("data/collateral/onchain.json");
        string memory quotePath =
            vm.envOr("QUOTE_PATH", string("data/quote_deepseek_deepseek-v4-flash-0731.hex"));
        bytes memory quote = CollateralJson.loadQuote(quotePath);
        (bool success, bytes memory output) = IDcap(a.dcapAttestation).verifyAndAttestOnChain(quote, tcbEval);
        console.log("success:", success);
        console.logBytes(output);
    }
}
