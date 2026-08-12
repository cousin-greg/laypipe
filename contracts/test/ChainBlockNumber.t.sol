// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    ChainBlockNumber,
    IArbSysBlockNumber
} from "../src/lib/ChainBlockNumber.sol";

contract ChainBlockNumberHarness {
    function current() external view returns (uint256) {
        return ChainBlockNumber.current();
    }
}

contract ChainBlockNumberTest is Test {
    address internal constant ARBSYS =
        0x0000000000000000000000000000000000000064;

    ChainBlockNumberHarness internal harness;

    function setUp() public {
        harness = new ChainBlockNumberHarness();
    }

    function testNonRobinhoodRehearsalUsesNativeChainBlockNumber() public {
        vm.chainId(84532);
        vm.roll(12_345);
        assertEq(harness.current(), 12_345);
    }

    function testRobinhoodUsesArbSysInsteadOfSolidityBlockNumber() public {
        vm.chainId(4663);
        vm.roll(111);
        vm.mockCall(
            ARBSYS,
            abi.encodeCall(IArbSysBlockNumber.arbBlockNumber, ()),
            abi.encode(uint256(987_654))
        );

        assertEq(harness.current(), 987_654);
        assertNotEq(harness.current(), block.number);
    }

    function testRobinhoodFailsClosedWhenArbSysIsUnavailable() public {
        vm.chainId(4663);
        vm.expectRevert(ChainBlockNumber.ArbSysUnavailable.selector);
        harness.current();
    }
}
