// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";

contract P256Probe is Test {
    address constant P256 = 0x0000000000000000000000000000000000000100;

    bytes constant PUBKEY =
        hex"710f9d7cb59f86798aaf92138320831b778016d02cf0f5b416a76917f85edd4d7440615935921eaaa33c66c6cf4b745e70176a391610ab14f845d7ff39b112a3";
    bytes constant SIG =
        hex"8c6a3bb0346ec08d01b6351eeff099fd7131de48e5e569dbcd9dc3f29e08995692db2eaebd633a52fff4915d274859bbc241967c6ce3a6831e754b88066fc534";
    bytes constant MSG = hex"a9b4ac5fb82203536c408b1db1d0338c61fd0064ea2471794d435fc0e03c217f";

    function test_precompile_present() public view {
        bytes memory args = abi.encodePacked(sha256(MSG), SIG, PUBKEY);
        require(args.length == 160, "bad len");
        (bool ok, bytes memory ret) = P256.staticcall(args);
        console.log("evm ok:", ok, "retlen:", ret.length);
        if (ret.length == 32) console.log("value:", abi.decode(ret, (uint256)));
    }
}
