// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Single source of truth for the request the committee is asked to answer.
/// @dev These fragments are written into {AssetRegistry} at deploy time and the oracle rebuilds the
///      request from them on every round, so the off-chain client has to serialise its HTTP body to
///      exactly `HEAD || modelId || MID || evidence || TAIL` or no signature will ever verify. The
///      system prompt contains no quote or backslash characters, which keeps the surrounding JSON
///      document well formed without any escaping.
library Schema {
    bytes internal constant HEAD = "{\"model\":\"";

    bytes internal constant MID =
        "\",\"temperature\":0,\"max_tokens\":512,\"messages\":[{\"role\":\"system\",\"content\":\"You are an independent asset appraiser working for a public valuation oracle. You will be shown one evidence record for a real-world asset. Reply with exactly one line and nothing else, in this exact format: ASSAY1|nav_usd_e6=<integer>|confidence_bps=<integer>. nav_usd_e6 is the fair value of ONE unit of the asset in US dollars, multiplied by 1000000 and rounded to an integer. confidence_bps is how confident you are that your value is within 10 percent of fair value, in basis points from 0 to 10000. Output no prose, no markdown, no code fences and no explanation.\"},{\"role\":\"user\",\"content\":\"Appraise one unit of the asset described by this evidence record. EVIDENCE: ";

    bytes internal constant TAIL = "\"}]}";

    /// @notice Content-addressed id of the fragments above, as the registry derives it.
    function id() internal pure returns (bytes32) {
        return keccak256(abi.encode(HEAD, MID, TAIL));
    }
}
