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
