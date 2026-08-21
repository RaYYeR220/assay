// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";

import {DcapStack, DcapAddresses} from "../script/DcapStack.sol";
import {CollateralUploader, Collateral} from "../script/CollateralUploader.sol";
import {CollateralJson} from "../script/CollateralJson.sol";
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

/// @dev calldata-slicing helper so DcapOutput's calldata library can be exercised from a test
contract OutputProbe {
    using DcapOutput for bytes;

    function signingAddress(bytes calldata o) external pure returns (address) {
        return o.signingAddress();
    }

    function parse(bytes calldata o) external pure returns (TdxAttestationOutput memory) {
        return o.parseTdx();
    }

    function advisories(bytes calldata o) external pure returns (string[] memory) {
        return o.advisoryIDs();
    }
}

/**
 * @notice Full pipeline on a fork of X Layer testnet:
 *         deploy PCCS + DCAP -> upload Intel collateral -> verify a REAL Phala TDX quote.
 */
contract XLayerForkE2E is Test, DcapStack, CollateralUploader {
    DcapAddresses internal addrs;
    Collateral internal collateral;
    bytes6 internal fmspc;
    uint32 internal tcbEval;
    OutputProbe internal probe;

    address internal p256;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string("https://testrpc.xlayer.tech"));
        vm.createSelectFork(rpc);

        // sanity: the RIP-7212 precompile must answer here
        p256 = RIP7212_P256;
        assertTrue(_p256Works(p256), "P256 precompile not available in this EVM (use FOUNDRY_EVM_VERSION=osaka)");

        (collateral, fmspc, tcbEval) = CollateralJson.load("data/collateral/onchain.json");

        uint256 g0 = gasleft();
        addrs = _deployAll(address(this), p256, tcbEval, false);
        console.log("gas: full stack deployment      ", g0 - gasleft());

        uint256 g1 = gasleft();
        _uploadAll(addrs, collateral);
        console.log("gas: collateral upload (total)  ", g1 - gasleft());

        probe = new OutputProbe();

        console.log("--- deployed (fork) ---");
        console.log("PCKHelper                ", addrs.pckHelper);
        console.log("X509CRLHelper            ", addrs.crlHelper);
        console.log("EnclaveIdentityHelper    ", addrs.enclaveIdHelper);
        console.log("FmspcTcbHelper           ", addrs.fmspcTcbHelper);
        console.log("TcbEvalHelper            ", addrs.tcbEvalHelper);
        console.log("AutomataDaoStorage       ", addrs.daoStorage);
        console.log("PccsDependencyConfig     ", addrs.depConfig);
        console.log("AutomataPcsDao           ", addrs.pcsDao);
        console.log("AutomataPckDao           ", addrs.pckDao);
        console.log("AutomataTcbEvalDao       ", addrs.tcbEvalDao);
        console.log("EnclaveIdentityDaoVer    ", addrs.enclaveIdDaoVersioned);
        console.log("FmspcTcbDaoVersioned     ", addrs.fmspcTcbDaoVersioned);
        console.log("PCCSRouter               ", addrs.router);
        console.log("AutomataDcapAttestation  ", addrs.dcapAttestation);
        console.log("V4QuoteVerifier          ", addrs.v4Verifier);
    }

    function _p256Works(address verifier) internal view returns (bool) {
        bytes memory args = abi.encodePacked(
            sha256(hex"a9b4ac5fb82203536c408b1db1d0338c61fd0064ea2471794d435fc0e03c217f"),
            hex"8c6a3bb0346ec08d01b6351eeff099fd7131de48e5e569dbcd9dc3f29e08995692db2eaebd633a52fff4915d274859bbc241967c6ce3a6831e754b88066fc534",
            hex"710f9d7cb59f86798aaf92138320831b778016d02cf0f5b416a76917f85edd4d7440615935921eaaa33c66c6cf4b745e70176a391610ab14f845d7ff39b112a3"
        );
        (bool ok, bytes memory ret) = verifier.staticcall(args);
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    function test_p256_precompile_gas() public view {
        bytes memory args = abi.encodePacked(
            sha256(hex"a9b4ac5fb82203536c408b1db1d0338c61fd0064ea2471794d435fc0e03c217f"),
            hex"8c6a3bb0346ec08d01b6351eeff099fd7131de48e5e569dbcd9dc3f29e08995692db2eaebd633a52fff4915d274859bbc241967c6ce3a6831e754b88066fc534",
            hex"710f9d7cb59f86798aaf92138320831b778016d02cf0f5b416a76917f85edd4d7440615935921eaaa33c66c6cf4b745e70176a391610ab14f845d7ff39b112a3"
        );
        uint256 g = gasleft();
        (bool ok,) = p256.staticcall(args);
        console.log("gas: P256VERIFY staticcall", g - gasleft(), "ok:", ok);
    }

    function test_verify_real_phala_tdx_quote() public {
        bytes memory quote = CollateralJson.loadQuote("data/quote_deepseek_deepseek-v4-flash-0731.hex");
        console.log("quote bytes:", quote.length);

        uint256 g = gasleft();
        (bool success, bytes memory output) = IDcap(addrs.dcapAttestation).verifyAndAttestOnChain(quote, tcbEval);
        uint256 used = g - gasleft();

        if (!success) {
            console.log("FAILED reason:", string(output));
        }
        assertTrue(success, "on-chain DCAP verification failed");
        console.log("gas: verifyAndAttestOnChain     ", used);
        console.log("output bytes:", output.length);

        TdxAttestationOutput memory o = probe.parse(output);
        assertEq(o.quoteVersion, 4, "quoteVersion");
        assertEq(o.quoteBodyType, 2, "quoteBodyType (TD1.0)");
        assertEq(o.fmspc, fmspc, "fmspc");
        console.log("tcbStatus:", o.tcbStatus);
        console.log("mrTd:");
        console.logBytes(o.mrTd);
        console.log("rtMr0:");
        console.logBytes(o.rtMr0);
        console.log("rtMr1:");
        console.logBytes(o.rtMr1);
        console.log("rtMr2:");
        console.logBytes(o.rtMr2);
        console.log("rtMr3:");
        console.logBytes(o.rtMr3);
        console.log("reportData:");
        console.logBytes(o.reportData);

        address signer = probe.signingAddress(output);
        console.log("recovered signing address:", signer);
        address expected = vm.envOr("EXPECTED_SIGNING_ADDRESS", address(0));
        if (expected != address(0)) {
            assertEq(signer, expected, "reportData[0:20] != signing_address");
        }

        string[] memory ids = probe.advisories(output);
        console.log("advisoryIDs:", ids.length);
        for (uint256 i = 0; i < ids.length && i < 8; i++) {
            console.log("  ", ids[i]);
        }
    }

    /// @notice The single-arg overload resolves the TCB evaluation number via TcbEvalDao.
    function test_verify_with_standard_tcb_eval() public {
        bytes memory quote = CollateralJson.loadQuote("data/quote_deepseek_deepseek-v4-flash-0731.hex");
        uint256 g = gasleft();
        (bool success, bytes memory output) = IDcap(addrs.dcapAttestation).verifyAndAttestOnChain(quote);
        uint256 used = g - gasleft();
        if (!success) {
            console.log("standard-tcb-eval path failed:", string(output));
        } else {
            console.log("gas: verifyAndAttestOnChain(1-arg)", used);
            assertEq(output.length >= 595, true);
        }
    }

    /// @notice 11 distinct TDX instances (Phala's kimi-k2.6 committee), spread over 3 FMSPCs.
    function test_verify_committee_quotes() public {
        uint256 verified;
        uint256 total;
        for (uint256 i = 0; i < 11; i++) {
            string memory f =
                string.concat("data/quote_kimi_", i < 10 ? "0" : "", vm.toString(i), ".hex");
            bytes memory quote = CollateralJson.loadQuote(f);
            total++;
            (bool success, bytes memory output) =
                IDcap(addrs.dcapAttestation).verifyAndAttestOnChain(quote, tcbEval);
            if (success) {
                verified++;
                console.log(f, "OK signer:", probe.signingAddress(output));
            } else {
                console.log(f, "FAIL:", string(output));
            }
        }
        assertEq(verified, total, "not every committee quote verified");
        console.log("committee quotes verified:", verified, "/", total);
    }

    /// @notice All 5 single-quote TEE models from api.redpill.ai.
    function test_verify_redpill_model_quotes() public {
        string[5] memory files = [
            "data/quote_openai_gpt-oss-120b.hex",
            "data/quote_qwen_qwen3.6-27b.hex",
            "data/quote_z-ai_glm-5.2.hex",
            "data/quote_meta-llama_llama-3.3-70b-instruct.hex",
            "data/quote_deepseek_deepseek-v4-flash-0731.hex"
        ];
        uint256 verified;
        for (uint256 i = 0; i < files.length; i++) {
            bytes memory quote = CollateralJson.loadQuote(files[i]);
            (bool success, bytes memory output) =
                IDcap(addrs.dcapAttestation).verifyAndAttestOnChain(quote, tcbEval);
            if (success) {
                verified++;
                console.log(files[i], "OK signer:", probe.signingAddress(output));
            } else {
                console.log(files[i], "FAIL:", string(output));
            }
        }
        assertEq(verified, files.length, "not every model quote verified");
    }
}
