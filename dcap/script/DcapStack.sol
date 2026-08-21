// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// --- automata-on-chain-pccs ---
import {EnclaveIdentityHelper} from "@automata-network/on-chain-pccs/helpers/EnclaveIdentityHelper.sol";
import {FmspcTcbHelper} from "@automata-network/on-chain-pccs/helpers/FmspcTcbHelper.sol";
import {PCKHelper} from "@automata-network/on-chain-pccs/helpers/PCKHelper.sol";
import {X509CRLHelper} from "@automata-network/on-chain-pccs/helpers/X509CRLHelper.sol";
import {TcbEvalHelper} from "@automata-network/on-chain-pccs/helpers/TcbEvalHelper.sol";
import {AutomataDaoStorage} from "@automata-network/on-chain-pccs/automata_pccs/shared/AutomataDaoStorage.sol";
import {PccsDependencyConfig} from "@automata-network/on-chain-pccs/automata_pccs/shared/PccsDependencyConfig.sol";
import {AutomataPcsDao} from "@automata-network/on-chain-pccs/automata_pccs/AutomataPcsDao.sol";
import {AutomataPckDao} from "@automata-network/on-chain-pccs/automata_pccs/AutomataPckDao.sol";
import {AutomataTcbEvalDao} from "@automata-network/on-chain-pccs/automata_pccs/AutomataTcbEvalDao.sol";
import {AutomataEnclaveIdentityDaoVersioned} from
    "@automata-network/on-chain-pccs/automata_pccs/versioned/AutomataEnclaveIdentityDaoVersioned.sol";
import {AutomataFmspcTcbDaoVersioned} from
    "@automata-network/on-chain-pccs/automata_pccs/versioned/AutomataFmspcTcbDaoVersioned.sol";

// --- automata-dcap-attestation ---
import {PCCSRouter} from "@automata-network/dcap-attestation/PCCSRouter.sol";
import {AutomataDcapAttestationFee} from "@automata-network/dcap-attestation/AutomataDcapAttestationFee.sol";
import {V4QuoteVerifier} from "@automata-network/dcap-attestation/verifiers/V4QuoteVerifier.sol";
import {V3QuoteVerifier} from "@automata-network/dcap-attestation/verifiers/V3QuoteVerifier.sol";

struct DcapAddresses {
    // PCCS helpers
    address enclaveIdHelper;
    address fmspcTcbHelper;
    address pckHelper;
    address crlHelper;
    address tcbEvalHelper;
    // PCCS core
    address daoStorage;
    address depConfig;
    address pcsDao;
    address pckDao;
    address tcbEvalDao;
    address enclaveIdDaoVersioned;
    address fmspcTcbDaoVersioned;
    // DCAP
    address router;
    address dcapAttestation;
    address v3Verifier;
    address v4Verifier;
}

/**
 * @title DcapStack
 * @notice Deployment logic for the full Automata on-chain PCCS + DCAP attestation stack,
 *         factored out so that the Foundry deploy script and the fork test share
 *         exactly the same code path.
 * @dev `p256` should be 0x...0100 (RIP-7212 / EIP-7951 P256VERIFY precompile) on X Layer.
 */
abstract contract DcapStack {
    /// @dev RIP-7212 precompile, live on X Layer mainnet (196) and testnet (1952)
    address internal constant RIP7212_P256 = 0x0000000000000000000000000000000000000100;
    uint256 internal constant ATTESTER_ROLE = 1 << 0; // solady _ROLE_0

    function _deployHelpers(DcapAddresses memory a) internal {
        a.enclaveIdHelper = address(new EnclaveIdentityHelper());
        a.fmspcTcbHelper = address(new FmspcTcbHelper());
        a.pckHelper = address(new PCKHelper());
        a.crlHelper = address(new X509CRLHelper());
        a.tcbEvalHelper = address(new TcbEvalHelper());
    }

    function _deployPccs(DcapAddresses memory a, address owner, address p256, uint32 tcbEval) internal {
        AutomataDaoStorage pccsStorage = new AutomataDaoStorage(owner);
        a.daoStorage = address(pccsStorage);

        AutomataPcsDao pcsDao = new AutomataPcsDao(a.daoStorage, p256, a.pckHelper, a.crlHelper);
        a.pcsDao = address(pcsDao);

        AutomataPckDao pckDao = new AutomataPckDao(a.daoStorage, p256, a.pcsDao, a.pckHelper, a.crlHelper);
        a.pckDao = address(pckDao);

        PccsDependencyConfig depConfig = new PccsDependencyConfig(owner);
        depConfig.initialize(a.pcsDao, a.crlHelper);
        a.depConfig = address(depConfig);

        AutomataTcbEvalDao tcbEvalDao =
            new AutomataTcbEvalDao(a.daoStorage, p256, a.depConfig, a.tcbEvalHelper, a.pckHelper, owner);
        a.tcbEvalDao = address(tcbEvalDao);

        AutomataEnclaveIdentityDaoVersioned qeIdDao = new AutomataEnclaveIdentityDaoVersioned(
            a.daoStorage, p256, a.depConfig, a.enclaveIdHelper, a.pckHelper, owner, tcbEval
        );
        a.enclaveIdDaoVersioned = address(qeIdDao);

        AutomataFmspcTcbDaoVersioned tcbDao = new AutomataFmspcTcbDaoVersioned(
            a.daoStorage, p256, a.pcsDao, a.fmspcTcbHelper, a.pckHelper, a.crlHelper, owner, tcbEval
        );
        a.fmspcTcbDaoVersioned = address(tcbDao);

        // DAO -> storage write permissions
        pccsStorage.grantDao(a.pcsDao);
        pccsStorage.grantDao(a.pckDao);
        pccsStorage.grantDao(a.tcbEvalDao);
        pccsStorage.grantDao(a.enclaveIdDaoVersioned);
        pccsStorage.grantDao(a.fmspcTcbDaoVersioned);

        // attester role: whoever uploads Intel collateral
        tcbEvalDao.grantRoles(owner, ATTESTER_ROLE);
        qeIdDao.grantRoles(owner, ATTESTER_ROLE);
        tcbDao.grantRoles(owner, ATTESTER_ROLE);
    }

    function _deployDcap(DcapAddresses memory a, address owner, address p256, uint32 tcbEval, bool withV3)
        internal
    {
        PCCSRouter router = new PCCSRouter(
            owner, a.tcbEvalDao, a.pcsDao, a.pckDao, a.pckHelper, a.crlHelper, a.fmspcTcbHelper
        );
        a.router = address(router);

        AutomataDaoStorage(a.daoStorage).setCallerAuthorization(a.router, true);

        router.setQeIdDaoVersionedAddr(tcbEval, a.enclaveIdDaoVersioned);
        router.setFmspcTcbDaoVersionedAddr(tcbEval, a.fmspcTcbDaoVersioned);

        AutomataDcapAttestationFee dcap = new AutomataDcapAttestationFee(owner);
        a.dcapAttestation = address(dcap);

        V4QuoteVerifier v4 = new V4QuoteVerifier(p256, a.router);
        a.v4Verifier = address(v4);
        router.setAuthorized(a.v4Verifier, true);
        dcap.setQuoteVerifier(a.v4Verifier);

        if (withV3) {
            V3QuoteVerifier v3 = new V3QuoteVerifier(p256, a.router);
            a.v3Verifier = address(v3);
            router.setAuthorized(a.v3Verifier, true);
            dcap.setQuoteVerifier(a.v3Verifier);
        }
    }

    function _deployAll(address owner, address p256, uint32 tcbEval, bool withV3)
        internal
        returns (DcapAddresses memory a)
    {
        _deployHelpers(a);
        _deployPccs(a, owner, p256, tcbEval);
        _deployDcap(a, owner, p256, tcbEval, withV3);
    }
}
