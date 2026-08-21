// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ascii} from "../src/libraries/Ascii.sol";

/// @notice The library that decides what the chain thinks the enclave said. Checked against the
///         cheatcode's own hex rendering rather than against itself.
contract AsciiTest is Test {
    function test_ToHex64_MatchesAnIndependentRendering() public pure {
        bytes32 digest = sha256("assay");
        string memory expected = vm.replace(vm.toString(digest), "0x", "");
        assertEq(string(Ascii.toHex64(digest)), expected);
        assertEq(Ascii.toHex64(digest).length, 64);
    }

    function test_ToHex64_IsLowerCaseAndZeroPadded() public pure {
        bytes memory out = Ascii.toHex64(bytes32(uint256(0x0a)));
        assertEq(string(out), "000000000000000000000000000000000000000000000000000000000000000a");
    }

    function testFuzz_ToHex64_MatchesAnIndependentRendering(bytes32 value) public pure {
        assertEq(string(Ascii.toHex64(value)), vm.replace(vm.toString(value), "0x", ""));
    }

    // -----------------------------------------------------------------------------------
    // matchAt
    // -----------------------------------------------------------------------------------

    function test_MatchAt_RequiresTheWholePatternInsideTheBuffer() public pure {
        bytes memory data = "hello world";
        assertTrue(Ascii.matchAt(data, 0, "hello"));
        assertTrue(Ascii.matchAt(data, 6, "world"));
        assertFalse(Ascii.matchAt(data, 7, "world"), "a pattern running off the end does not match");
        assertFalse(Ascii.matchAt(data, 11, "d"));
        assertFalse(Ascii.matchAt(data, type(uint32).max, "h"));
        assertTrue(Ascii.matchAt(data, 11, ""), "an empty pattern matches at the end");
    }

    function test_MatchAt_IsCaseAndByteExact() public pure {
        assertFalse(Ascii.matchAt("hello", 0, "Hello"));
        assertFalse(Ascii.matchAt("hello", 0, "hell0"));
    }

    // -----------------------------------------------------------------------------------
    // indexOf and locate
    // -----------------------------------------------------------------------------------

    /// @dev The scan is written in assembly and compares a word at a time, so it is checked against
    ///      the obvious byte-by-byte version rather than against itself.
    function _naiveIndexOf(bytes memory data, uint256 from, bytes memory pattern)
        internal
        pure
        returns (uint256, bool)
    {
        uint256 n = pattern.length;
        if (n == 0 || data.length < n) return (0, false);
        for (uint256 i = from; i + n <= data.length; ++i) {
            bool hit = true;
            for (uint256 j = 0; j < n; ++j) {
                if (data[i + j] != pattern[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return (i, true);
        }
        return (0, false);
    }

    function _assertAgrees(bytes memory data, uint256 from, bytes memory pattern) internal pure {
        (uint256 wantIndex, bool wantFound) = _naiveIndexOf(data, from, pattern);
        (uint256 gotIndex, bool gotFound) = Ascii.indexOf(data, from, pattern);
        assertEq(gotFound, wantFound);
        if (wantFound) assertEq(gotIndex, wantIndex);
    }

    function test_IndexOf_HandlesTheEdgesOfTheBuffer() public pure {
        _assertAgrees("hello world", 0, "hello");
        _assertAgrees("hello world", 0, "world");
        _assertAgrees("hello world", 7, "world");
        _assertAgrees("hello world", 0, "hello world");
        _assertAgrees("hello world", 0, "hello world!");
        _assertAgrees("hello world", 0, "");
        _assertAgrees("", 0, "x");
        _assertAgrees("aaaa", 0, "aa");
        _assertAgrees("aaaa", 3, "aa");
        _assertAgrees("hello", 99, "h");
    }

    function test_IndexOf_HandlesPatternsLongerThanAWord() public pure {
        bytes memory long = "0123456789abcdefghijklmnopqrstuvwxyz0123456789";
        _assertAgrees(bytes.concat("prefix ", long, " suffix"), 0, long);
        _assertAgrees(bytes.concat("prefix ", long), 0, bytes.concat(long, "x"));

        // Differs only past the first word, which is where the tail comparison takes over.
        bytes memory nearly = bytes.concat("0123456789abcdefghijklmnopqrstuv", "DIFFERENT");
        _assertAgrees(bytes.concat("prefix ", long), 0, nearly);
    }

    function test_IndexOf_ReturnsTheFirstOccurrence() public pure {
        bytes memory data = "xx MARK yy MARK zz";
        (uint256 i, bool found) = Ascii.indexOf(data, 0, "MARK");
        assertTrue(found);
        assertEq(i, 3);

        (uint256 j, bool foundSecond) = Ascii.indexOf(data, i + 1, "MARK");
        assertTrue(foundSecond);
        assertEq(j, 11);
    }

    /// @dev `locate` takes no hint on purpose: a hint is not covered by the signature, so letting it
    ///      short-circuit the scan would let whoever posts a round choose between two markers that
    ///      the enclave signed.
    function test_Locate_IsTheFirstOccurrence() public pure {
        bytes memory data = "aa PAT bb PAT cc";
        (uint256 i, bool found) = Ascii.locate(data, "PAT");
        assertTrue(found);
        assertEq(i, 3);

        (, bool missing) = Ascii.locate(data, "NOPE");
        assertFalse(missing);
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_IndexOf_AgreesWithAByteScan(bytes memory data, bytes memory pattern, uint16 from)
        public
        pure
    {
        _assertAgrees(data, bound(uint256(from), 0, 300), pattern);
    }

    /// @dev Random buffers almost never contain a random pattern, so this plants one first.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_IndexOf_FindsAPlantedPattern(bytes memory noise, bytes memory pattern, uint16 at)
        public
        pure
    {
        vm.assume(pattern.length > 0 && pattern.length < 40);
        uint256 where = bound(uint256(at), 0, noise.length);
        bytes memory data = bytes.concat(_slice(noise, 0, where), pattern, _slice(noise, where, noise.length));
        _assertAgrees(data, 0, pattern);
        _assertAgrees(data, where, pattern);
        (, bool found) = Ascii.indexOf(data, 0, pattern);
        assertTrue(found, "a planted pattern is always there to be found");
    }

    function _slice(bytes memory data, uint256 start, uint256 end) internal pure returns (bytes memory out) {
        out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            out[i - start] = data[i];
        }
    }

    // -----------------------------------------------------------------------------------
    // readUint
    // -----------------------------------------------------------------------------------

    function test_ReadUint_StopsAtTheFirstNonDigit() public pure {
        (uint256 value, uint256 next, bool ok) = Ascii.readUint("1234|rest", 0);
        assertTrue(ok);
        assertEq(value, 1234);
        assertEq(next, 4);
    }

    function test_ReadUint_AcceptsLeadingZeroes() public pure {
        (uint256 value,, bool ok) = Ascii.readUint("000042", 0);
        assertTrue(ok);
        assertEq(value, 42);
    }

    function test_ReadUint_FailsWithoutADigit() public pure {
        (, uint256 next, bool ok) = Ascii.readUint("abc", 0);
        assertFalse(ok);
        assertEq(next, 0);

        (,, bool okPastEnd) = Ascii.readUint("123", 3);
        assertFalse(okPastEnd);

        (,, bool okFarPastEnd) = Ascii.readUint("123", 9999);
        assertFalse(okFarPastEnd);
    }

    function test_ReadUint_RefusesAnAbsurdlyLongRun() public pure {
        bytes memory thirty = "999999999999999999999999999999"; // 30 digits
        (uint256 value,, bool ok) = Ascii.readUint(thirty, 0);
        assertTrue(ok);
        assertEq(value, 999999999999999999999999999999);

        (,, bool okThirtyOne) = Ascii.readUint(bytes.concat(thirty, "9"), 0);
        assertFalse(okThirtyOne, "a run this long can only be an attempt to overflow");
    }

    // -----------------------------------------------------------------------------------
    // skipJsonWhitespace
    // -----------------------------------------------------------------------------------

    function test_SkipJsonWhitespace_SkipsSpacesAndEscapedWhitespace() public pure {
        assertEq(Ascii.skipJsonWhitespace("   x", 0, 8), 3);
        assertEq(Ascii.skipJsonWhitespace("\\n\\r\\tx", 0, 8), 6, "three two-byte escapes");
        assertEq(Ascii.skipJsonWhitespace(" \\n x", 0, 8), 4);
        assertEq(Ascii.skipJsonWhitespace("x", 0, 8), 0, "nothing to skip");
        assertEq(Ascii.skipJsonWhitespace("   ", 0, 8), 3, "running out of data ends the run");
    }

    function test_SkipJsonWhitespace_StopsAtAnyOtherEscape() public pure {
        assertEq(Ascii.skipJsonWhitespace("\\u0020x", 0, 8), 0, "a unicode escape is not whitespace");
        assertEq(Ascii.skipJsonWhitespace("\\\\x", 0, 8), 0, "an escaped backslash is not whitespace");
        assertEq(Ascii.skipJsonWhitespace(" .", 0, 8), 1, "punctuation ends the run");
    }

    function test_SkipJsonWhitespace_HonoursTheCap() public pure {
        assertEq(Ascii.skipJsonWhitespace("          x", 0, 8), 8, "at most eight items");
        assertEq(Ascii.skipJsonWhitespace("   x", 0, 0), 0);
    }

    function test_SkipJsonWhitespace_DoesNotReadPastATrailingBackslash() public pure {
        assertEq(Ascii.skipJsonWhitespace(" \\", 0, 8), 1, "a dangling escape is not whitespace");
    }

    // -----------------------------------------------------------------------------------
    // isJsonStringSafe
    // -----------------------------------------------------------------------------------

    function test_IsJsonStringSafe_AcceptsPrintableAscii() public pure {
        assertTrue(Ascii.isJsonStringSafe(""));
        assertTrue(Ascii.isJsonStringSafe("asset_id=carbon-001;credits=1000 (verified)"));
        assertTrue(Ascii.isJsonStringSafe(" ~"), "the printable range runs from 0x20 to 0x7e");
    }

    function test_IsJsonStringSafe_RejectsAnythingThatWouldReshapeTheDocument() public pure {
        assertFalse(Ascii.isJsonStringSafe('a"b'), "a quote would close the string early");
        assertFalse(Ascii.isJsonStringSafe("a\\b"), "a backslash would start an escape");
        assertFalse(Ascii.isJsonStringSafe("a\nb"));
        assertFalse(Ascii.isJsonStringSafe(hex"7f"), "delete is a control character");
        assertFalse(Ascii.isJsonStringSafe(hex"c3a9"), "multi-byte UTF-8 is outside the charset");
        assertFalse(Ascii.isJsonStringSafe(hex"00"));
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_IsJsonStringSafe_AgreesWithAByteScan(bytes memory data) public pure {
        bool expected = true;
        for (uint256 i = 0; i < data.length; ++i) {
            uint8 c = uint8(data[i]);
            if (c < 0x20 || c == 0x22 || c == 0x5c || c > 0x7e) {
                expected = false;
                break;
            }
        }
        assertEq(Ascii.isJsonStringSafe(data), expected);
    }
}
