// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {CA} from "@automata-network/on-chain-pccs/Common.sol";
import {AutomataPcsDao} from "@automata-network/on-chain-pccs/automata_pccs/AutomataPcsDao.sol";
import {AutomataTcbEvalDao} from "@automata-network/on-chain-pccs/automata_pccs/AutomataTcbEvalDao.sol";
import {AutomataEnclaveIdentityDaoVersioned} from
    "@automata-network/on-chain-pccs/automata_pccs/versioned/AutomataEnclaveIdentityDaoVersioned.sol";
import {AutomataFmspcTcbDaoVersioned} from
    "@automata-network/on-chain-pccs/automata_pccs/versioned/AutomataFmspcTcbDaoVersioned.sol";
import {EnclaveIdentityJsonObj} from "@automata-network/on-chain-pccs/helpers/EnclaveIdentityHelper.sol";
import {TcbInfoJsonObj} from "@automata-network/on-chain-pccs/helpers/FmspcTcbHelper.sol";
import {TcbEvalJsonObj} from "@automata-network/on-chain-pccs/helpers/TcbEvalHelper.sol";

import {DcapAddresses} from "./DcapStack.sol";

/// @notice Everything needed to make ONE specific TDX quote verifiable on-chain.
/// @dev Produced off-chain by `data/build_onchain_collateral.py` into
///      `data/collateral/onchain.json`, so the deploy is reproducible without
///      hitting Intel PCS at deploy time.
struct Collateral {
    bytes rootCaDer;
    bytes rootCrlDer;
    bytes tcbSigningDer;
    bytes pckCaDer;
    uint8 pckCa; // CA enum: 1 = PROCESSOR, 2 = PLATFORM
    bytes pckCrlDer;
    /// @dev one entry per FMSPC we want verifiable; index 0 is the primary quote's FMSPC
    string[] tcbInfoStrs;
    bytes[] tcbInfoSigs;
    string qeIdentityStr;
    bytes qeIdentitySig;
    string tcbEvalStr;
    bytes tcbEvalSig;
}

uint256 constant ENCLAVE_ID_TD_QE = 2; // EnclaveId.TD_QE
uint256 constant PCS_API_V4 = 4;

/**
 * @title CollateralUploader
 * @notice Pushes the Intel PCS collateral for a single FMSPC into on-chain PCCS.
 */
abstract contract CollateralUploader {
    function _uploadPcs(DcapAddresses memory a, Collateral memory c) internal {
        AutomataPcsDao pcs = AutomataPcsDao(a.pcsDao);

        // Order matters: root first (it anchors every signature check below).
        pcs.upsertPcsCertificates(CA.ROOT, c.rootCaDer);
        pcs.upsertRootCACrl(c.rootCrlDer);
        pcs.upsertPcsCertificates(CA.SIGNING, c.tcbSigningDer);
        pcs.upsertPcsCertificates(CA(c.pckCa), c.pckCaDer);
        pcs.upsertPckCrl(CA(c.pckCa), c.pckCrlDer);
    }

    function _uploadTcbEval(DcapAddresses memory a, Collateral memory c) internal {
        if (bytes(c.tcbEvalStr).length == 0) return;
        AutomataTcbEvalDao(a.tcbEvalDao).upsertTcbEvaluationData(
            TcbEvalJsonObj({tcbEvaluationDataNumbers: c.tcbEvalStr, signature: c.tcbEvalSig})
        );
    }

    function _uploadQeIdentity(DcapAddresses memory a, Collateral memory c) internal {
        AutomataEnclaveIdentityDaoVersioned(a.enclaveIdDaoVersioned).upsertEnclaveIdentity(
            ENCLAVE_ID_TD_QE,
            PCS_API_V4,
            EnclaveIdentityJsonObj({identityStr: c.qeIdentityStr, signature: c.qeIdentitySig})
        );
    }

    function _uploadFmspcTcb(DcapAddresses memory a, Collateral memory c) internal {
        AutomataFmspcTcbDaoVersioned dao = AutomataFmspcTcbDaoVersioned(a.fmspcTcbDaoVersioned);
        for (uint256 i = 0; i < c.tcbInfoStrs.length; i++) {
            dao.upsertFmspcTcb(TcbInfoJsonObj({tcbInfoStr: c.tcbInfoStrs[i], signature: c.tcbInfoSigs[i]}));
        }
    }

    function _uploadAll(DcapAddresses memory a, Collateral memory c) internal {
        _uploadPcs(a, c);
        _uploadTcbEval(a, c);
        _uploadQeIdentity(a, c);
        _uploadFmspcTcb(a, c);
    }
}
