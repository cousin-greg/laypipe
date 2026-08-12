// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {LaypipeToken} from "../src/LaypipeToken.sol";
import {IArbSysBlockNumber} from
    "../src/lib/ChainBlockNumber.sol";

contract TokenCloneFactory {
    address public hook = address(0xBEEF);

    function create(LaypipeToken implementation, address creator)
        external
        returns (LaypipeToken token)
    {
        token = LaypipeToken(
            Clones.cloneDeterministic(
                address(implementation), bytes32(uint256(1))
            )
        );
        token.initialize(
            LaypipeToken.TokenConfig({
                name: "Pipe Pup",
                symbol: "PUP",
                logo: "ipfs://logo",
                description: "checkpoint test",
                metadataURI: "ipfs://metadata",
                socials: LaypipeToken.Socials({
                    telegram: "",
                    twitter: "",
                    discord: "",
                    website: "",
                    extra: ""
                }),
                creator: creator,
                supply: 1_000_000 ether,
                taxBps: 100
            })
        );
        token.initializePool(bytes32(uint256(123)));
        token.transfer(creator, token.totalSupply());
    }
}

contract LaypipeTokenTest is Test {
    address internal constant ARBSYS =
        0x0000000000000000000000000000000000000064;
    address internal constant HOLDER = address(0xA11CE);
    address internal constant RECIPIENT = address(0xB0B);

    function testClosedBlockBalanceAndSupplyCheckpointsRemainHistorical()
        public
    {
        LaypipeToken implementation = new LaypipeToken();
        TokenCloneFactory cloneFactory = new TokenCloneFactory();
        LaypipeToken token = cloneFactory.create(implementation, HOLDER);

        uint64 initialBlock = uint64(block.number);
        uint256 initialBalance = token.balanceOf(HOLDER);
        uint256 initialSupply = token.totalSupply();

        vm.roll(block.number + 1);
        uint64 nextBlock = initialBlock + 1;
        vm.prank(HOLDER);
        token.transfer(RECIPIENT, initialBalance / 2);
        vm.prank(RECIPIENT);
        token.burn(initialBalance / 4);

        assertEq(token.balanceOfAt(HOLDER, initialBlock), initialBalance);
        assertEq(token.totalSupplyAt(initialBlock), initialSupply);
        assertEq(
            token.balanceOfAt(HOLDER, nextBlock),
            initialBalance / 2
        );
        assertEq(
            token.totalSupplyAt(nextBlock),
            initialSupply - initialBalance / 4
        );
        assertTrue(token.supportsBlockCheckpoints());
        assertTrue(token.supportsBlockBalanceCheckpoints());
    }

    function testRobinhoodLaunchAndCheckpointsUseArbSysBlockNumber()
        public
    {
        vm.chainId(4663);
        vm.roll(111);
        _mockArbBlockNumber(700);

        LaypipeToken implementation = new LaypipeToken();
        TokenCloneFactory cloneFactory = new TokenCloneFactory();
        LaypipeToken token = cloneFactory.create(implementation, HOLDER);
        uint256 initialBalance = token.balanceOf(HOLDER);

        assertEq(token.launchBlock(), 700);
        assertEq(token.balanceOfAt(HOLDER, 700), initialBalance);
        assertEq(token.balanceOfAt(HOLDER, 699), 0);

        // Advancing Solidity's block number alone must not advance the
        // Robinhood checkpoint clock.
        vm.roll(222);
        _mockArbBlockNumber(701);
        vm.prank(HOLDER);
        token.transfer(RECIPIENT, initialBalance / 2);

        assertEq(token.balanceOfAt(HOLDER, 700), initialBalance);
        assertEq(token.balanceOfAt(HOLDER, 701), initialBalance / 2);
    }

    function testCheckpointClockFailsClosedAboveUint64() public {
        vm.roll(uint256(type(uint64).max) + 1);

        LaypipeToken implementation = new LaypipeToken();
        TokenCloneFactory cloneFactory = new TokenCloneFactory();
        vm.expectRevert(LaypipeToken.BlockNumberTooLarge.selector);
        cloneFactory.create(implementation, HOLDER);
    }

    function _mockArbBlockNumber(uint256 number) private {
        vm.clearMockedCalls();
        vm.mockCall(
            ARBSYS,
            abi.encodeCall(IArbSysBlockNumber.arbBlockNumber, ()),
            abi.encode(number)
        );
    }
}
