// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AssetConfig, RejectReason, Verdict} from "../src/Types.sol";
import {MockQuoteAdapter} from "./mocks/MockQuoteAdapter.sol";

/// @notice Shared rig: a deployed protocol plus the byte-level helpers that reproduce, in the test,
///         exactly what a confidential-inference gateway would have produced and signed.
/// @dev Every offset handed to the oracle here is found by searching the response for the literal
///      pattern, never by counting characters. A test that hardcoded an index would keep passing
///      after the response shape changed and would stop proving anything.
abstract contract Fixtures is Test {
    // Prompt fragments. Assembled by the registry as head || modelId || mid || evidence || tail.
    bytes internal constant HEAD = '{"model":"';
    bytes internal constant MID = '","messages":[{"role":"user","content":"EVIDENCE: ';
    bytes internal constant TAIL = '"}]}';

    string internal constant MODEL_0 = "vendor-a/model-alpha";
    string internal constant MODEL_1 = "vendor-b/model-beta";
    string internal constant MODEL_2 = "vendor-c/model-gamma";
    string internal constant MODEL_3 = "vendor-d/model-delta";
    string internal constant MODEL_4 = "vendor-e/model-epsilon";

    uint256 internal constant PK_0 = uint256(keccak256("signer.0"));
    uint256 internal constant PK_1 = uint256(keccak256("signer.1"));
    uint256 internal constant PK_2 = uint256(keccak256("signer.2"));
    uint256 internal constant PK_3 = uint256(keccak256("signer.3"));
    uint256 internal constant PK_4 = uint256(keccak256("signer.4"));

    bytes32 internal constant MEASUREMENT = keccak256("assay.test.image.v1");
    uint256 internal constant MAX_NAV_E6 = 1e24;
    uint256 internal constant MAX_RESPONSE = 2048;
    uint256 internal constant START_TIME = 1_800_000_000;

    bytes32 internal constant EV_VERDICT_REJECTED =
        keccak256("VerdictRejected(bytes32,uint32,uint8,address,uint8)");

    MockQuoteAdapter internal adapter;
    AttestationRegistry internal attestations;
    AssetRegistry internal assets;
    AssayOracle internal oracle;

    bytes32 internal schemaId;
    bytes32 internal assetId = keccak256("assay.test.asset.carbon.v1");
    address internal issuer;
    bytes internal evidence = "schema=assay.test.v1;asset_id=carbon-001;credits=1000;vintage=2024";

    function setUp() public virtual {
        vm.warp(START_TIME);
        issuer = makeAddr("issuer");

        adapter = new MockQuoteAdapter();
        attestations = new AttestationRegistry(adapter, address(this));
        attestations.setAllowedImage(MEASUREMENT, true);
        assets = new AssetRegistry();
        oracle = new AssayOracle(assets, attestations, address(this));

        schemaId = assets.registerSchema(HEAD, MID, TAIL);
        registerAsset(assetId, committee3(), defaultConfig());

        attest(PK_0, MODEL_0);
        attest(PK_1, MODEL_1);
        attest(PK_2, MODEL_2);
    }

    // -----------------------------------------------------------------------------------
    // Deployment helpers
    // -----------------------------------------------------------------------------------

    function defaultConfig() internal view returns (AssetConfig memory) {
        return AssetConfig({
            issuer: address(0),
            quorum: 3,
            minDistinctSigners: 3,
            bandBps: 500,
            minConfidenceBps: 5000,
            maxAgeSec: 3600,
            disputeBandBps: 500,
            disputeBond: 0.01 ether,
            schemaId: schemaId,
            active: true
        });
    }

    function committee3() internal pure returns (string[] memory m) {
        m = new string[](3);
        m[0] = MODEL_0;
        m[1] = MODEL_1;
        m[2] = MODEL_2;
    }

    function committee5() internal pure returns (string[] memory m) {
        m = new string[](5);
        m[0] = MODEL_0;
        m[1] = MODEL_1;
        m[2] = MODEL_2;
        m[3] = MODEL_3;
        m[4] = MODEL_4;
    }

    function registerAsset(bytes32 id, string[] memory models, AssetConfig memory cfg) internal {
        vm.prank(issuer);
        assets.registerAsset(id, cfg, models, "ipfs://assay/test");
        commit(id, evidence);
    }

    /// @notice Put `ev` on chain as evidence the issuer stands behind.
    /// @dev Every round has to run on committed evidence, so a fixture that lists an asset commits
    ///      the default document with it. Hashed before the prank: sha256 is a precompile call and
    ///      would otherwise consume it.
    function commit(bytes32 id, bytes memory ev) internal {
        bytes32 evidenceHash = sha256(ev);
        vm.prank(issuer);
        assets.commitEvidence(id, evidenceHash, "ipfs://assay/test/evidence", true);
    }

    function pkAt(uint256 i) internal pure returns (uint256) {
        uint256[5] memory pks = [PK_0, PK_1, PK_2, PK_3, PK_4];
        return pks[i];
    }

    function modelName(uint256 i) internal pure returns (string memory) {
        string[5] memory names = [MODEL_0, MODEL_1, MODEL_2, MODEL_3, MODEL_4];
        return names[i];
    }

    /// @notice List an asset with `n` distinct models and attest one signer per slot.
    function listCommittee(bytes32 id, uint256 n, uint8 quorum, uint8 minDistinct) internal {
        string[] memory models = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            models[i] = modelName(i);
        }
        AssetConfig memory cfg = defaultConfig();
        cfg.quorum = quorum;
        cfg.minDistinctSigners = minDistinct;
        registerAsset(id, models, cfg);
        for (uint256 i = 0; i < n; ++i) {
            attest(pkAt(i), modelName(i));
        }
    }

    /// @notice One well-formed verdict per slot of `id`, answering `navs[i]` at `block.timestamp`.
    function roundFor(bytes32 id, uint256[] memory navs) internal view returns (Verdict[] memory vs) {
        vs = new Verdict[](navs.length);
        for (uint256 i = 0; i < navs.length; ++i) {
            vs[i] = goodVerdict(pkAt(i), id, uint8(i), navs[i], 9000, block.timestamp);
        }
    }

    function navList(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory n) {
        n = new uint256[](3);
        (n[0], n[1], n[2]) = (a, b, c);
    }

    function navList(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory n) {
        n = new uint256[](4);
        (n[0], n[1], n[2], n[3]) = (a, b, c, d);
    }

    function navList(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e)
        internal
        pure
        returns (uint256[] memory n)
    {
        n = new uint256[](5);
        (n[0], n[1], n[2], n[3], n[4]) = (a, b, c, d, e);
    }

    /// @notice Attest `pk` for `modelId` through a quote the mock adapter reports as verified.
    function attest(uint256 pk, string memory modelId) internal returns (address signer) {
        signer = vm.addr(pk);
        adapter.setAccepting(MEASUREMENT, signer, 0);
        attestations.registerSigner(hex"deadbeef", modelId);
    }

    // -----------------------------------------------------------------------------------
    // Response bodies
    // -----------------------------------------------------------------------------------

    /// @notice An OpenAI-compatible chat completion carrying `content` verbatim.
    function responseBody(uint256 created, string memory model, string memory content, string memory finish)
        internal
        pure
        returns (bytes memory)
    {
        return bytes(
            string.concat(
                '{"id":"chatcmpl-abc","object":"chat.completion","created":',
                vm.toString(created),
                ',"model":"',
                model,
                '","choices":[{"index":0,"message":{"role":"assistant","content":"',
                content,
                '"},"finish_reason":"',
                finish,
                '"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}'
            )
        );
    }

    /// @notice The same completion with `padLen` filler bytes inside the id, which sits ahead of
    ///         every field the parser has to find. Used to size the worst case a scan can face.
    function paddedResponseBody(
        uint256 created,
        string memory model,
        string memory content,
        string memory finish,
        uint256 padLen
    ) internal pure returns (bytes memory) {
        bytes memory filler = new bytes(padLen);
        for (uint256 i = 0; i < padLen; ++i) {
            filler[i] = "x";
        }
        return bytes(
            string.concat(
                '{"id":"chatcmpl-',
                string(filler),
                '","object":"chat.completion","created":',
                vm.toString(created),
                ',"model":"',
                model,
                '","choices":[{"index":0,"message":{"role":"assistant","content":"',
                content,
                '"},"finish_reason":"',
                finish,
                '"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}'
            )
        );
    }

    /// @notice A well-formed answer padded out to exactly `totalLength` bytes.
    function paddedBody(bytes32 id, uint8 slot, uint256 nav, uint256 conf, uint256 created, uint256 totalLength)
        internal
        view
        returns (bytes memory)
    {
        string memory model = assets.modelAt(id, slot);
        uint256 bare = paddedResponseBody(created, model, marker(nav, conf), "stop", 0).length;
        require(totalLength >= bare, "target length shorter than the answer");
        return paddedResponseBody(created, model, marker(nav, conf), "stop", totalLength - bare);
    }

    function marker(uint256 nav, uint256 conf) internal pure returns (string memory) {
        return string.concat("ASSAY1|nav_usd_e6=", vm.toString(nav), "|confidence_bps=", vm.toString(conf));
    }

    /// @notice The well-formed answer a committee member in `slot` is meant to produce.
    function goodBody(bytes32 id, uint8 slot, uint256 nav, uint256 conf, uint256 created)
        internal
        view
        returns (bytes memory)
    {
        return responseBody(created, assets.modelAt(id, slot), marker(nav, conf), "stop");
    }

    // -----------------------------------------------------------------------------------
    // Signing
    // -----------------------------------------------------------------------------------

    /// @notice Reproduce the 129-character payload the enclave signs, and sign it.
    /// @dev sha256hex(request) ":" sha256hex(response), under the EIP-191 personal-sign prefix.
    function sign(uint256 pk, bytes32 id, uint8 slot, bytes memory ev, bytes memory body)
        internal
        view
        returns (bytes memory)
    {
        bytes memory request = assets.buildRequest(id, slot, ev);
        bytes memory payload = bytes(string.concat(hex64(sha256(request)), ":", hex64(sha256(body))));
        assertEq(payload.length, 129, "signed payload must be 129 characters");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(bytes.concat("\x19Ethereum Signed Message:\n129", payload)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Independent of the library under test: taken from the cheatcode's hex rendering.
    function hex64(bytes32 value) internal pure returns (string memory) {
        bytes memory prefixed = bytes(vm.toString(value));
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            out[i] = prefixed[i + 2];
        }
        return string(out);
    }

    /// @notice A verdict is just a slot, the raw response and the signature over it. There is
    ///         nothing else to fill in, which is the point: no field here travels unsigned.
    function verdictOf(uint256 pk, bytes32 id, uint8 slot, bytes memory ev, bytes memory body)
        internal
        view
        returns (Verdict memory)
    {
        return Verdict({slot: slot, responseBody: body, signature: sign(pk, id, slot, ev, body)});
    }

    function goodVerdict(uint256 pk, bytes32 id, uint8 slot, uint256 nav, uint256 conf, uint256 created)
        internal
        view
        returns (Verdict memory)
    {
        return verdictOf(pk, id, slot, evidence, goodBody(id, slot, nav, conf, created));
    }

    /// @notice Three agreeing members of the default committee, all answering at `block.timestamp`.
    function agreeingRound(uint256 nav) internal view returns (Verdict[] memory vs) {
        vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, assetId, 0, nav, 9000, block.timestamp);
        vs[1] = goodVerdict(PK_1, assetId, 1, nav, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, assetId, 2, nav, 9000, block.timestamp);
    }

    /// @notice Three members answering with one value each, in slot order.
    function roundOf(uint256 nav0, uint256 nav1, uint256 nav2) internal view returns (Verdict[] memory vs) {
        vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, assetId, 0, nav0, 9000, block.timestamp);
        vs[1] = goodVerdict(PK_1, assetId, 1, nav1, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, assetId, 2, nav2, 9000, block.timestamp);
    }

    function post(Verdict[] memory vs) internal returns (bool) {
        return oracle.postAppraisal(assetId, evidence, vs);
    }

    /// @notice Publish a NAV of `nav` and return to a state where consumers can read it.
    function publish(uint256 nav) internal {
        assertTrue(post(agreeingRound(nav)), "fixture round should publish");
    }

    function indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint32) {
        (uint32 at, bool found) = find(haystack, needle, 0);
        require(found, "pattern not present in body");
        return at;
    }

    function find(bytes memory haystack, bytes memory needle, uint256 from)
        internal
        pure
        returns (uint32 at, bool found)
    {
        if (needle.length == 0 || haystack.length < needle.length) return (0, false);
        for (uint256 i = from; i + needle.length <= haystack.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < needle.length; ++j) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return (uint32(i), true);
        }
        return (0, false);
    }

    function contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        (, bool found) = find(haystack, needle, 0);
        return found;
    }

    /// @notice Replace the byte at `at`, leaving the length untouched.
    function tamper(bytes memory data, uint256 at, bytes1 to) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[at] = to;
    }

    // -----------------------------------------------------------------------------------
    // Log reading
    // -----------------------------------------------------------------------------------

    /// @notice The reason the oracle gave for dropping `slot` in the round just posted.
    /// @dev Read back from logs rather than asserted with expectEmit: a tampered payload recovers
    ///      to an address no test can predict, so the event data cannot be written down up front.
    function rejectionFor(uint8 slot) internal view returns (RejectReason) {
        return reasonIn(vm.getRecordedLogs(), slot);
    }

    /// @dev Reading the recorded logs consumes them, so a round with several rejections has to be
    ///      decoded from one captured array rather than by asking slot by slot.
    function reasonIn(Vm.Log[] memory logs, uint8 slot) internal pure returns (RejectReason) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length != 4 || logs[i].topics[0] != EV_VERDICT_REJECTED) continue;
            if (uint256(logs[i].topics[3]) != slot) continue;
            (, uint8 reason) = abi.decode(logs[i].data, (address, uint8));
            return RejectReason(reason);
        }
        revert("no VerdictRejected emitted for slot");
    }

    /// @notice Post a round while recording logs, and report why `slot` was dropped.
    function postAndReadRejection(Verdict[] memory vs, uint8 slot) internal returns (RejectReason) {
        vm.recordLogs();
        post(vs);
        return rejectionFor(slot);
    }
}
