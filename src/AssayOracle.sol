// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AssetRegistry} from "./AssetRegistry.sol";
import {AttestationRegistry} from "./AttestationRegistry.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IAssayOracle} from "./interfaces/IAssayOracle.sol";
import {Ascii} from "./libraries/Ascii.sol";
import {AssetConfig, HaltReason, Nav, NavState, RejectReason, Verdict} from "./Types.sol";

/// @title AssayOracle
/// @notice A net asset value oracle for assets that no price feed covers, built so that refusing to
///         publish is a first-class outcome rather than an error path.
///
/// @dev The round is deliberately paranoid, and every check happens here rather than off chain:
///
///      1. The request is rebuilt, not accepted. {AssetRegistry} stores the prompt fragments, so
///         this contract concatenates the exact bytes each enclave was asked to answer and hashes
///         them itself. A relayer cannot substitute a friendlier question.
///      2. The response is hashed here too, from the raw bytes handed in. Together with (1) that
///         reproduces the 129-character string the enclave signed, which is checked with
///         `ecrecover` against a key that {AttestationRegistry} accepted only after verifying an
///         Intel TDX quote on chain.
///      3. The answer is parsed strictly. A committee member must reply with one marker line and
///         nothing else; prose, markdown, a truncated generation or a missing field all fail. The
///         timestamp used for freshness is read out of the signed response, not asserted by whoever
///         posts it.
///      4. Failures do not revert, they are recorded. A bad member is dropped with a reason and the
///         round continues. If too few survive, or the survivors disagree by more than the band, or
///         the sequencer is not healthy, the oracle records a halt and publishes nothing.
///
///      The consequence is that consumers can only ever read a price that a quorum of attested
///      enclaves agreed on, recently, on evidence this contract can point at. Everything else stops
///      the flow of value at {requireFreshNav}.
contract AssayOracle is IAssayOracle {
    using Ascii for bytes;

    struct Dispute {
        address challenger;
        uint96 bond;
        uint32 epoch;
        uint64 openedAt;
        bool open;
    }

    /// @dev Scratch space for one round. Kept in a struct because a round needs more live values
    ///      than the stack can hold.
    struct Round {
        uint256[] values;
        address[] signers;
        uint256 n;
        uint64 observedAt;
        uint64 newestAt;
        uint8 distinct;
        uint8 authed;
    }

    uint256 internal constant MAX_EVIDENCE = 8192;
    /// @dev The parser scans the body for three patterns, so the cost of a round is linear in this
    ///      number. A real answer to this prompt measures a few hundred bytes; the cap leaves ample
    ///      headroom while keeping the worst case a caller can construct to a few million gas
    ///      rather than a large fraction of a block.
    uint256 internal constant MAX_RESPONSE = 2048;
    uint256 internal constant MAX_NAV_E6 = 1e24;
    uint256 internal constant BPS = 10_000;

    /// @dev EIP-191 personal-sign prefix for the fixed 129-byte payload the gateway signs.
    bytes internal constant EIP191_PREFIX_129 = "\x19Ethereum Signed Message:\n129";

    /// @dev A single ASCII colon, the separator between the two hex digests.
    bytes internal constant COLON = hex"3a";

    AssetRegistry public immutable assets;
    AttestationRegistry public immutable attestations;

    address public owner;

    /// @notice Chainlink L2 sequencer uptime feed. Optional; when unset the check is skipped.
    IAggregatorV3 public sequencerFeed;

    /// @notice How long the sequencer must have been back up before prices are trusted again.
    uint64 public sequencerGrace = 30 minutes;

    /// @notice Tolerance for a response timestamp slightly ahead of block time.
    uint64 public futureSkew = 120;

    /// @notice How long a challenger has to back a challenge with a fresh committee round.
    /// @dev A challenge freezes consumers the moment it is opened, so it cannot be allowed to sit
    ///      there indefinitely. Anyone may settle it with a real round; if nobody does, the
    ///      challenge lapses and the bond goes to the issuer.
    uint64 public challengeWindow = 6 hours;

    // Response grammar. Owner-settable so the oracle can track a gateway serialisation change
    // without a redeploy. These decide which bytes count as a well-formed answer; they cannot
    // manufacture a signature, so the worst a bad value can do is halt the oracle.
    bytes public contentPrefix = "\"content\":\"ASSAY1|nav_usd_e6=";
    bytes public confidenceInfix = "|confidence_bps=";
    bytes public contentSuffix = "\"";
    bytes public finishPattern = "\"finish_reason\":\"stop\"";
    bytes public createdPattern = "\"created\":";

    mapping(bytes32 assetId => Nav) internal _navs;
    mapping(bytes32 assetId => uint32) public epochOf;
    mapping(bytes32 assetId => HaltReason) public lastHaltReason;
    mapping(bytes32 assetId => uint32) public haltCount;
    mapping(bytes32 assetId => Dispute) public disputes;

    /// @notice Bonds credited by dispute outcomes, claimable with {withdraw}.
    mapping(address account => uint256) public pendingWithdrawals;

    /// @notice Timestamp floor for the next round: the observation time of the last published NAV.
    /// @dev Without this, whoever posts a round could keep a favourable set of signed answers in a
    ///      drawer and re-post it after a later round disagreed, because the signatures stay valid
    ///      for as long as the freshness window. Requiring every accepted answer to be strictly
    ///      newer than the newest answer of the last published round retires the whole set at once.
    mapping(bytes32 assetId => uint64) public observationWatermark;

    event AppraisalPosted(
        bytes32 indexed assetId,
        uint32 indexed epoch,
        uint128 valueE6,
        uint8 accepted,
        uint8 distinctSigners,
        uint64 observedAt,
        bytes32 evidenceHash
    );
    event Halted(
        bytes32 indexed assetId, uint32 indexed epoch, HaltReason reason, uint8 accepted, bytes32 evidenceHash
    );
    event VerdictAccepted(
        bytes32 indexed assetId,
        uint32 indexed epoch,
        uint8 indexed slot,
        address signer,
        uint256 navE6,
        uint256 confidenceBps,
        uint64 createdAt
    );
    event VerdictRejected(
        bytes32 indexed assetId, uint32 indexed epoch, uint8 indexed slot, address signer, RejectReason reason
    );
    event Challenged(bytes32 indexed assetId, uint32 indexed epoch, address indexed challenger, uint256 bond);
    event DisputeResolved(
        bytes32 indexed assetId, uint32 indexed epoch, bool challengerWon, uint128 recheckedValueE6
    );
    /// @notice A round that carried too few authentic enclave signatures to mean anything.
    /// @dev Emitted instead of a halt. Halting is a strong action, so it is reserved for rounds
    ///      that actually reached the committee.
    event RoundIgnored(bytes32 indexed assetId, uint32 indexed epoch, uint8 authenticated, bytes32 evidenceHash);
    event Credited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event SequencerFeedSet(address feed, uint64 grace);
    event GrammarSet();

    error NotOwner();
    error EvidenceTooLong();
    error EvidenceNotJsonSafe();
    error CommitteeIncomplete(uint256 given, uint256 expected);
    error AssetNotActive();
    error OracleHalted(bytes32 assetId, HaltReason reason);
    error NavStale(bytes32 assetId, uint64 observedAt);
    error NavDisputed(bytes32 assetId);
    error NoNav(bytes32 assetId);
    error SequencerDown();
    error DisputeAlreadyOpen();
    error NoOpenDispute();
    error BondTooSmall(uint256 sent, uint256 required);
    error NothingToChallenge();
    error BondTransferFailed();
    error EvidenceNotCommitted(bytes32 evidenceHash);
    error InconclusiveRound(HaltReason reason);
    error UnauthenticatedRound(uint8 authenticated);
    error DisputeStillOpen(uint64 until);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(AssetRegistry assets_, AttestationRegistry attestations_, address owner_) {
        assets = assets_;
        attestations = attestations_;
        owner = owner_;
    }

    // ---------------------------------------------------------------------------------------
    // Appraisal
    // ---------------------------------------------------------------------------------------

    /// @notice Run one appraisal round for `assetId` and either publish a NAV or record a halt.
    /// @param evidence the canonical evidence document the committee was shown, verbatim
    /// @param verdicts one entry per committee slot, all of them
    /// @return published true when a price was written, false when the oracle refused
    /// @dev The full committee must be submitted. That closes the obvious attack on a consensus
    ///      rule, which is to quietly omit the member who disagrees: an absent member has to be
    ///      posted as an empty answer, which is visibly rejected on chain and still counts against
    ///      quorum.
    function postAppraisal(bytes32 assetId, bytes calldata evidence, Verdict[] calldata verdicts)
        external
        returns (bool published)
    {
        AssetConfig memory cfg = assets.config(assetId);
        if (!cfg.active) revert AssetNotActive();
        // A challenge has to bite until it is settled. Without this an open dispute could be
        // stepped over by simply posting another round, which would put the NAV back into Live
        // while the bond is still at stake.
        if (disputes[assetId].open) revert DisputeAlreadyOpen();
        if (evidence.length > MAX_EVIDENCE) revert EvidenceTooLong();
        if (!Ascii.isJsonStringSafe(evidence)) revert EvidenceNotJsonSafe();

        uint256 members = assets.committeeSize(assetId);
        if (verdicts.length != members) revert CommitteeIncomplete(verdicts.length, members);

        bytes32 evidenceHash = sha256(evidence);
        if (!assets.evidenceAllowed(assetId, evidenceHash)) revert EvidenceNotCommitted(evidenceHash);

        uint32 epoch = ++epochOf[assetId];
        (bool ok, uint256 median, HaltReason reason, Round memory r) =
            _evaluateRound(assetId, epoch, evidence, verdicts, cfg);

        if (!ok) {
            if (reason == HaltReason.Unauthenticated) {
                emit RoundIgnored(assetId, epoch, r.authed, evidenceHash);
            } else {
                _recordHalt(assetId, epoch, reason, uint8(r.n), evidenceHash);
            }
            return false;
        }

        _navs[assetId] = Nav({
            valueE6: uint128(median),
            postedAt: uint64(block.timestamp),
            observedAt: r.observedAt,
            epoch: epoch,
            maxAgeSec: cfg.maxAgeSec,
            accepted: uint8(r.n),
            distinctSigners: r.distinct,
            state: NavState.Live,
            evidenceHash: evidenceHash
        });
        lastHaltReason[assetId] = HaltReason.None;
        observationWatermark[assetId] = r.newestAt;

        emit AppraisalPosted(
            assetId, epoch, uint128(median), uint8(r.n), r.distinct, r.observedAt, evidenceHash
        );
        return true;
    }

    function _evaluateRound(
        bytes32 assetId,
        uint32 epoch,
        bytes calldata evidence,
        Verdict[] calldata verdicts,
        AssetConfig memory cfg
    ) internal returns (bool ok, uint256 median, HaltReason reason, Round memory r) {
        if (!_sequencerHealthy()) return (false, 0, HaltReason.SequencerDown, r);

        r.values = new uint256[](verdicts.length);
        r.signers = new address[](verdicts.length);
        r.observedAt = type(uint64).max;

        uint256 seenSlots;
        for (uint256 i = 0; i < verdicts.length; ++i) {
            Verdict calldata v = verdicts[i];
            if (v.slot >= verdicts.length || (seenSlots >> v.slot) & 1 == 1) {
                emit VerdictRejected(assetId, epoch, v.slot, address(0), RejectReason.DuplicateSlot);
                continue;
            }
            seenSlots |= (uint256(1) << v.slot);

            (address signer, uint256 navE6, uint256 confBps, uint64 createdAt, RejectReason rej) =
                _checkVerdict(assetId, evidence, v, cfg);

            if (_reachedCommittee(rej)) {
                unchecked {
                    ++r.authed;
                }
            }

            if (rej != RejectReason.None) {
                emit VerdictRejected(assetId, epoch, v.slot, signer, rej);
                continue;
            }

            r.values[r.n] = navE6;
            r.signers[r.n] = signer;
            unchecked {
                ++r.n;
            }
            if (createdAt < r.observedAt) r.observedAt = createdAt;
            if (createdAt > r.newestAt) r.newestAt = createdAt;
            emit VerdictAccepted(assetId, epoch, v.slot, signer, navE6, confBps, createdAt);
        }

        r.distinct = _countDistinct(r.signers, r.n);

        // A round nobody could have produced without enclave access is not evidence of anything, so
        // it must not be able to halt the oracle. Without this, freezing every consumer would cost
        // an attacker one transaction of junk. A genuine committee outage is not silently tolerated
        // either: the last valuation simply keeps ageing and goes stale on its own.
        if (r.authed < cfg.quorum) {
            return (false, 0, HaltReason.Unauthenticated, r);
        }

        if (r.n < cfg.quorum || r.distinct < cfg.minDistinctSigners) {
            return (false, 0, HaltReason.InsufficientQuorum, r);
        }

        median = _median(r.values, r.n);
        if (!_withinBand(r.values, r.n, median, cfg.bandBps)) {
            return (false, median, HaltReason.Disagreement, r);
        }
        return (true, median, HaltReason.None, r);
    }

    /// @dev Reproduces what the enclave signed and then reads the answer out of it. Returns a
    ///      reason instead of reverting so one broken member cannot take the round down.
    function _checkVerdict(bytes32 assetId, bytes calldata evidence, Verdict calldata v, AssetConfig memory cfg)
        internal
        view
        returns (address signer, uint256 navE6, uint256 confBps, uint64 createdAt, RejectReason reason)
    {
        // Reported as a signature failure rather than a malformed answer, because no signature was
        // checked at all: nothing here came from the committee. Calling it malformed would put it
        // on the authenticated side of the round and hand anyone a free halt, since a round of
        // empty bodies costs nothing to assemble.
        if (v.responseBody.length == 0 || v.responseBody.length > MAX_RESPONSE) {
            return (address(0), 0, 0, 0, RejectReason.BadSignature);
        }

        {
            bytes memory request = assets.buildRequest(assetId, v.slot, evidence);
            bytes32 digest = keccak256(
                bytes.concat(
                    EIP191_PREFIX_129,
                    Ascii.toHex64(sha256(request)),
                    COLON,
                    Ascii.toHex64(sha256(v.responseBody))
                )
            );
            signer = _recover(digest, v.signature);
        }
        if (signer == address(0)) return (address(0), 0, 0, 0, RejectReason.BadSignature);

        {
            bytes32 modelIdHash = keccak256(bytes(assets.modelAt(assetId, v.slot)));
            (bool live, bool revoked, bool expired) = attestations.status(signer, modelIdHash);
            if (!live) {
                if (revoked) return (signer, 0, 0, 0, RejectReason.SignerRevoked);
                if (expired) return (signer, 0, 0, 0, RejectReason.SignerExpired);
                // An attested key answering for a model it was not attested for is a different
                // failure from a key nobody ever attested, and operators need to tell them apart.
                // The extra read only happens on a path that is already being rejected.
                if (attestations.signerInfo(signer).known) {
                    return (signer, 0, 0, 0, RejectReason.WrongModel);
                }
                return (signer, 0, 0, 0, RejectReason.UnknownSigner);
            }
        }

        // Freshness is established BEFORE the answer is read, and that ordering is load-bearing.
        // A rejection that counts towards `authed` is what lets a round halt the oracle, so if a
        // badly-formed answer could be counted without first proving it is recent, one authentic
        // but unparseable response would become a bearer token that halts this asset forever.
        {
            bool hasTimestamp;
            (createdAt, hasTimestamp) = _readCreated(v);
            if (!hasTimestamp) return (signer, 0, 0, 0, RejectReason.NoTimestamp);
        }
        if (createdAt > block.timestamp + futureSkew) return (signer, 0, 0, 0, RejectReason.Stale);
        if (block.timestamp > uint256(createdAt) + cfg.maxAgeSec) {
            return (signer, 0, 0, 0, RejectReason.Stale);
        }
        if (createdAt <= observationWatermark[assetId]) return (signer, 0, 0, 0, RejectReason.Stale);

        (navE6, confBps, reason) = _readAnswer(v);
        if (reason != RejectReason.None) return (signer, 0, 0, 0, reason);
        if (confBps < cfg.minConfidenceBps) return (signer, 0, 0, 0, RejectReason.LowConfidence);

        return (signer, navE6, confBps, createdAt, RejectReason.None);
    }

    /// @dev Reads the timestamp the gateway put in the signed response. Kept separate from the
    ///      answer so that freshness can be settled before anything else is looked at.
    function _readCreated(Verdict calldata v) internal view returns (uint64 createdAt, bool ok) {
        bytes memory body = v.responseBody;
        (uint256 at, bool found) = Ascii.locate(body, createdPattern);
        if (!found) return (0, false);
        (uint256 value,, bool okDigits) = Ascii.readUint(body, at + createdPattern.length);
        if (!okDigits || value > type(uint64).max) return (0, false);
        return (uint64(value), true);
    }

    /// @dev Strict reader for the one line a committee member is allowed to produce.
    ///
    ///      Positions are found by scanning rather than taken from the caller, so nothing outside
    ///      the signed payload can influence how the answer is read. The patterns open with an
    ///      unescaped quote, which cannot occur inside a JSON string value, so the first occurrence
    ///      is necessarily the real one and a model cannot fabricate a second copy of one inside
    ///      its own answer.
    function _readAnswer(Verdict calldata v)
        internal
        view
        returns (uint256 navE6, uint256 confBps, RejectReason reason)
    {
        bytes memory body = v.responseBody;

        (, bool hasFinish) = Ascii.locate(body, finishPattern);
        if (!hasFinish) return (0, 0, RejectReason.Truncated);

        (uint256 contentAt, bool hasContent) = Ascii.locate(body, contentPrefix);
        if (!hasContent) return (0, 0, RejectReason.Malformed);

        uint256 p = contentAt + contentPrefix.length;
        bool okNav;
        (navE6, p, okNav) = Ascii.readUint(body, p);
        if (!okNav) return (0, 0, RejectReason.Malformed);

        if (!Ascii.matchAt(body, p, confidenceInfix)) return (0, 0, RejectReason.Malformed);
        p += confidenceInfix.length;

        bool okConf;
        (confBps, p, okConf) = Ascii.readUint(body, p);
        if (!okConf) return (0, 0, RejectReason.Malformed);

        // Past trailing whitespace, the closing quote has to come immediately. Anything else means
        // the model added commentary, and commentary is what this oracle refuses to price on.
        p = Ascii.skipJsonWhitespace(body, p, 8);
        if (!Ascii.matchAt(body, p, contentSuffix)) return (0, 0, RejectReason.Malformed);

        if (navE6 == 0 || navE6 > MAX_NAV_E6 || confBps > BPS) {
            return (0, 0, RejectReason.OutOfRange);
        }
        return (navE6, confBps, RejectReason.None);
    }

    // ---------------------------------------------------------------------------------------
    // Consumption
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc IAssayOracle
    function requireFreshNav(bytes32 assetId) external view returns (uint256 valueE6) {
        Nav memory n = _navs[assetId];
        if (n.state == NavState.Empty) revert NoNav(assetId);
        if (n.state == NavState.Disputed) revert NavDisputed(assetId);
        if (n.state != NavState.Live) revert OracleHalted(assetId, lastHaltReason[assetId]);
        if (!_sequencerHealthy()) revert SequencerDown();
        if (block.timestamp > uint256(n.observedAt) + n.maxAgeSec) {
            revert NavStale(assetId, n.observedAt);
        }
        return n.valueE6;
    }

    /// @inheritdoc IAssayOracle
    function peekNav(bytes32 assetId) external view returns (Nav memory nav, bool usable) {
        nav = _navs[assetId];
        if (nav.state != NavState.Live) return (nav, false);
        if (!_sequencerHealthy()) return (nav, false);
        usable = block.timestamp <= uint256(nav.observedAt) + nav.maxAgeSec;
    }

    function navOf(bytes32 assetId) external view returns (Nav memory) {
        return _navs[assetId];
    }

    // ---------------------------------------------------------------------------------------
    // Disputes
    // ---------------------------------------------------------------------------------------

    /// @notice Post a bond to contest the current valuation. Consumers stop reading immediately.
    /// @dev A price nobody can argue with is just a different kind of trusted feed. Opening a
    ///      challenge is permissionless and bites before anyone adjudicates it, so the cost of
    ///      being wrong falls on the challenger, never on holders who would otherwise transact
    ///      against a value that is under question.
    function challenge(bytes32 assetId) external payable {
        Dispute storage d = disputes[assetId];
        if (d.open) revert DisputeAlreadyOpen();
        Nav storage n = _navs[assetId];
        if (n.state != NavState.Live) revert NothingToChallenge();

        AssetConfig memory cfg = assets.config(assetId);
        if (msg.value < cfg.disputeBond) revert BondTooSmall(msg.value, cfg.disputeBond);

        d.challenger = msg.sender;
        d.bond = uint96(msg.value);
        d.epoch = n.epoch;
        d.openedAt = uint64(block.timestamp);
        d.open = true;
        n.state = NavState.Disputed;

        emit Challenged(assetId, n.epoch, msg.sender, msg.value);
    }

    /// @notice Settle an open challenge by re-appraising with a fresh committee round.
    /// @dev The challenge is upheld when the fresh valuation lands further from the contested one
    ///      than the dispute band allows, or when the fresh round cannot reach consensus at all.
    ///      Refusing to price counts as evidence for the challenger, not against them.
    function resolveDispute(bytes32 assetId, bytes calldata evidence, Verdict[] calldata verdicts)
        external
        returns (bool challengerWon)
    {
        Dispute storage d = disputes[assetId];
        if (!d.open) revert NoOpenDispute();

        AssetConfig memory cfg = assets.config(assetId);
        if (evidence.length > MAX_EVIDENCE) revert EvidenceTooLong();
        if (!Ascii.isJsonStringSafe(evidence)) revert EvidenceNotJsonSafe();
        {
            uint256 members = assets.committeeSize(assetId);
            if (verdicts.length != members) revert CommitteeIncomplete(verdicts.length, members);
        }

        // The document the contested valuation was published with always settles the dispute about
        // it, whether or not the issuer still stands behind it. Requiring a live commitment here
        // instead would hand the issuer every dispute for nothing: withdrawing the commitment the
        // moment a challenge opened would make every resolution revert, and the challenge would
        // then lapse in their favour. Nothing is invented either way, since the hash has to match
        // either the valuation on chain or a commitment the issuer made.
        bytes32 evidenceHash = sha256(evidence);
        if (evidenceHash != _navs[assetId].evidenceHash && !assets.evidenceAllowed(assetId, evidenceHash))
        {
            revert EvidenceNotCommitted(evidenceHash);
        }

        uint32 epoch = ++epochOf[assetId];
        (bool ok, uint256 median, HaltReason reason, Round memory r) =
            _evaluateRound(assetId, epoch, evidence, verdicts, cfg);

        // Settling a challenge in the challenger's favour must cost a real committee round.
        // Otherwise opening a dispute and immediately closing it with junk would void a valuation
        // and refund the bond, which is a free way to take the oracle offline.
        if (reason == HaltReason.Unauthenticated) revert UnauthenticatedRound(r.authed);

        uint128 contested = _navs[assetId].valueE6;
        if (!ok) {
            // Only a committee that answered and disagreed counts for the challenger. A round that
            // merely failed to reach quorum is manufacturable by whoever calls this: the verdicts
            // are theirs to choose, and answers that are authentic but too old to count still
            // clear the authentication check. That case is left to {lapseDispute} and the
            // challenge window rather than settled here.
            if (reason != HaltReason.Disagreement) revert InconclusiveRound(reason);
            challengerWon = true;
        } else {
            uint256 dev = median > contested ? median - contested : contested - median;
            challengerWon = dev * BPS > uint256(median) * cfg.disputeBandBps;
        }

        address challenger = d.challenger;
        uint256 bond = d.bond;
        d.open = false;
        d.bond = 0;

        if (challengerWon) {
            _navs[assetId].state = NavState.Voided;
            lastHaltReason[assetId] = HaltReason.Disagreement;
            unchecked {
                ++haltCount[assetId];
            }
            emit Halted(assetId, epoch, HaltReason.Disagreement, uint8(r.n), evidenceHash);
            _credit(challenger, bond);
        } else {
            _navs[assetId] = Nav({
                valueE6: uint128(median),
                postedAt: uint64(block.timestamp),
                observedAt: r.observedAt,
                epoch: epoch,
                maxAgeSec: cfg.maxAgeSec,
                accepted: uint8(r.n),
                distinctSigners: r.distinct,
                state: NavState.Live,
                evidenceHash: evidenceHash
            });
            observationWatermark[assetId] = r.newestAt;
            _credit(cfg.issuer, bond);
            emit AppraisalPosted(
                assetId, epoch, uint128(median), uint8(r.n), r.distinct, r.observedAt, evidenceHash
            );
        }

        emit DisputeResolved(assetId, epoch, challengerWon, uint128(median));
    }

    /// @notice Close a challenge nobody backed with a fresh appraisal in time.
    /// @dev Permissionless. The bond goes to the issuer and the contested valuation returns to
    ///      service, which is the right default: a challenger who will not produce a counter-round
    ///      has only imposed a cost on everyone else.
    function lapseDispute(bytes32 assetId) external {
        Dispute storage d = disputes[assetId];
        if (!d.open) revert NoOpenDispute();
        uint64 until = d.openedAt + challengeWindow;
        if (block.timestamp <= until) revert DisputeStillOpen(until);

        uint256 bond = d.bond;
        d.open = false;
        d.bond = 0;

        Nav storage n = _navs[assetId];
        if (n.state == NavState.Disputed) n.state = NavState.Live;

        AssetConfig memory cfg = assets.config(assetId);
        _credit(cfg.issuer, bond);
        emit DisputeResolved(assetId, n.epoch, false, n.valueE6);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    /// @dev Credited rather than sent. An issuer address that cannot receive value — a contract
    ///      without a payable fallback, most obviously — would otherwise make every dispute
    ///      resolution revert, and since a dispute freezes consumers the asset would be bricked with
    ///      no way back. Nobody should be able to take an oracle offline by choosing an awkward
    ///      address.
    function _credit(address to, uint256 amount) internal {
        if (amount == 0) return;
        pendingWithdrawals[to] += amount;
        emit Credited(to, amount);
    }

    /// @notice Withdraw bonds credited to you by a dispute outcome.
    function withdraw() external returns (uint256 amount) {
        amount = pendingWithdrawals[msg.sender];
        if (amount == 0) return 0;
        pendingWithdrawals[msg.sender] = 0;
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert BondTransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function _recordHalt(bytes32 assetId, uint32 epoch, HaltReason reason, uint8 accepted, bytes32 evidenceHash)
        internal
    {
        Nav storage n = _navs[assetId];
        n.state = NavState.Halted;
        n.epoch = epoch;
        n.accepted = accepted;
        lastHaltReason[assetId] = reason;
        unchecked {
            ++haltCount[assetId];
        }
        emit Halted(assetId, epoch, reason, accepted, evidenceHash);
    }

    function _sequencerHealthy() internal view returns (bool) {
        IAggregatorV3 feed = sequencerFeed;
        if (address(feed) == address(0)) return true;
        (, int256 answer, uint256 startedAt,,) = feed.latestRoundData();
        if (answer != 0) return false;
        // `startedAt == 0` is Chainlink's marker for a round that has not begun, and a feed
        // reporting a future start would underflow the subtraction below. Both mean the feed is
        // not telling us the sequencer is reliably up, and neither may revert: {peekNav} promises
        // an answer rather than an exception.
        if (startedAt == 0 || startedAt > block.timestamp) return false;
        return block.timestamp - startedAt > sequencerGrace;
    }

    /// @dev Whether a rejected verdict still counts as this round having reached the committee.
    ///      Yes when the signature checked out against a key that is live for the slot, the answer
    ///      belonged to this round, and it then failed on its merits. No when it failed to
    ///      authenticate, and no when it was never an answer to this round: an attested key
    ///      answering for the wrong model is not that slot's member, and a recycled answer from an
    ///      earlier round carries a perfectly good signature. Counting either would put a free halt
    ///      back within reach of anyone holding one attested key or a copy of the last round's
    ///      calldata.
    function _reachedCommittee(RejectReason rej) internal pure returns (bool) {
        return rej == RejectReason.None || rej == RejectReason.Truncated || rej == RejectReason.Malformed
            || rej == RejectReason.OutOfRange || rej == RejectReason.LowConfidence;
    }

    function _countDistinct(address[] memory signers, uint256 n) internal pure returns (uint8 distinct) {
        for (uint256 i = 0; i < n; ++i) {
            bool dup;
            for (uint256 j = 0; j < i; ++j) {
                if (signers[j] == signers[i]) {
                    dup = true;
                    break;
                }
            }
            if (!dup) ++distinct;
        }
    }

    function _median(uint256[] memory values, uint256 n) internal pure returns (uint256) {
        uint256[] memory a = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            a[i] = values[i];
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = key;
        }
        if (n % 2 == 1) return a[n / 2];
        return (a[n / 2 - 1] + a[n / 2]) / 2;
    }

    function _withinBand(uint256[] memory values, uint256 n, uint256 median, uint256 bandBps)
        internal
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < n; ++i) {
            uint256 dev = values[i] > median ? values[i] - median : median - values[i];
            if (dev * BPS > median * bandBps) return false;
        }
        return true;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }

    // ---------------------------------------------------------------------------------------
    // Governance
    // ---------------------------------------------------------------------------------------

    function setSequencerFeed(IAggregatorV3 feed, uint64 grace) external onlyOwner {
        sequencerFeed = feed;
        sequencerGrace = grace;
        emit SequencerFeedSet(address(feed), grace);
    }

    function setGrammar(
        bytes calldata contentPrefix_,
        bytes calldata confidenceInfix_,
        bytes calldata contentSuffix_,
        bytes calldata finishPattern_,
        bytes calldata createdPattern_
    ) external onlyOwner {
        contentPrefix = contentPrefix_;
        confidenceInfix = confidenceInfix_;
        contentSuffix = contentSuffix_;
        finishPattern = finishPattern_;
        createdPattern = createdPattern_;
        emit GrammarSet();
    }

    function setFutureSkew(uint64 skew) external onlyOwner {
        futureSkew = skew;
    }

    function setChallengeWindow(uint64 window) external onlyOwner {
        challengeWindow = window;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
