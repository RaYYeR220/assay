// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Ascii
/// @notice Byte-level helpers used to rebuild and inspect the exact HTTP payloads that a
///         confidential-inference enclave signed. Everything works on raw bytes because the chain
///         has to see the same octets the TEE saw, not a re-encoded approximation of them.
library Ascii {
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";

    /// @notice Lower-case, unprefixed hex expansion of a 32-byte digest (64 ASCII characters).
    /// @dev The gateway signs `sha256hex(request) ":" sha256hex(response)`, so a digest has to be
    ///      rendered as text before it can be hashed again.
    function toHex64(bytes32 value) internal pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            out[i * 2] = HEX_DIGITS[b >> 4];
            out[i * 2 + 1] = HEX_DIGITS[b & 0x0f];
        }
    }

    /// @notice True when `pattern` occurs in `data` starting exactly at `offset`.
    /// @dev Callers pass the offset in as a hint. A wrong hint simply fails the match, so a hint can
    ///      never be used to smuggle a different reading of the payload.
    function matchAt(bytes memory data, uint256 offset, bytes memory pattern)
        internal
        pure
        returns (bool)
    {
        uint256 n = pattern.length;
        if (offset + n > data.length) return false;
        for (uint256 i = 0; i < n; ++i) {
            if (data[offset + i] != pattern[i]) return false;
        }
        return true;
    }

    /// @notice Reads a run of ASCII digits.
    /// @return value the parsed number
    /// @return next index of the first non-digit byte
    /// @return ok false when there was no digit, the run is absurdly long, or it overflows
    function readUint(bytes memory data, uint256 offset)
        internal
        pure
        returns (uint256 value, uint256 next, bool ok)
    {
        uint256 i = offset;
        uint256 len = data.length;
        uint256 digits;
        while (i < len) {
            uint8 c = uint8(data[i]);
            if (c < 0x30 || c > 0x39) break;
            value = value * 10 + (c - 0x30);
            unchecked {
                ++i;
                ++digits;
            }
            if (digits > 30) return (0, offset, false);
        }
        if (digits == 0) return (0, offset, false);
        return (value, i, true);
    }

    /// @notice Steps over trailing whitespace at the end of a JSON string value.
    /// @dev Accepts literal spaces and the escape sequences for newline, carriage return and tab,
    ///      and nothing else. Models routinely end a line with a newline; refusing an answer over
    ///      that would be pedantry rather than strictness. Letters, punctuation and any other escape
    ///      still terminate the run, so this cannot be widened into tolerance for prose.
    /// @param maxRun cap on how many whitespace items may be skipped
    function skipJsonWhitespace(bytes memory data, uint256 offset, uint256 maxRun)
        internal
        pure
        returns (uint256 next)
    {
        next = offset;
        uint256 steps;
        while (next < data.length && steps < maxRun) {
            uint8 c = uint8(data[next]);
            if (c == 0x20) {
                unchecked {
                    ++next;
                    ++steps;
                }
                continue;
            }
            if (c == 0x5c && next + 1 < data.length) {
                uint8 d = uint8(data[next + 1]);
                if (d == 0x6e || d == 0x72 || d == 0x74) {
                    unchecked {
                        next += 2;
                        ++steps;
                    }
                    continue;
                }
            }
            break;
        }
    }

    /// @notice Rejects any byte that would change the shape of the JSON document the evidence is
    ///         embedded into: quotes, backslashes, and control characters.
    /// @dev Evidence is interpolated into a request body that the contract rebuilds verbatim. If a
    ///      caller could inject `"` or `\` they could restructure the prompt, so the charset is
    ///      constrained once at registration time rather than trusted at appraisal time.
    function isJsonStringSafe(bytes memory data) internal pure returns (bool) {
        for (uint256 i = 0; i < data.length; ++i) {
            uint8 c = uint8(data[i]);
            if (c < 0x20 || c == 0x22 || c == 0x5c || c > 0x7e) return false;
        }
        return true;
    }
}
