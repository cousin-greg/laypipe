// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {LaypipeSwapRouter} from "../src/LaypipeSwapRouter.sol";
import {PipedogHook} from "../src/PipedogHook.sol";

contract SwapRouterCodeStub {}

contract LaypipeSwapRouterTest is Test {
    address internal constant ARBSYS = 0x0000000000000000000000000000000000000064;
    address internal constant RECIPIENT = address(0xB0B);

    LaypipeSwapRouter internal router;

    function setUp() public {
        IPoolManager manager = IPoolManager(address(new SwapRouterCodeStub()));
        IERC20 pipedog = IERC20(address(new SwapRouterCodeStub()));
        PipedogHook hook = PipedogHook(address(new SwapRouterCodeStub()));
        vm.mockCall(
            address(hook), abi.encodeWithSelector(bytes4(keccak256("poolManager()"))), abi.encode(address(manager))
        );
        vm.mockCall(
            address(hook), abi.encodeWithSelector(bytes4(keccak256("quoteToken()"))), abi.encode(address(pipedog))
        );
        router = new LaypipeSwapRouter(manager, pipedog, hook);
    }

    function testBuyAndSellRejectExpiredNativeChainBlockIntent() public {
        vm.chainId(84_532);
        vm.roll(123);
        PoolKey memory key;

        vm.expectRevert(abi.encodeWithSelector(LaypipeSwapRouter.TradeExpired.selector, 122, 123));
        router.buy(key, 1, 0, RECIPIENT, 122);

        vm.expectRevert(abi.encodeWithSelector(LaypipeSwapRouter.TradeExpired.selector, 122, 123));
        router.sell(key, 1, 0, RECIPIENT, 122);
    }

    function testDeadlineIncludesItsCanonicalBlock() public {
        vm.chainId(84_532);
        vm.roll(123);
        PoolKey memory key;

        vm.expectRevert(LaypipeSwapRouter.InvalidPool.selector);
        router.buy(key, 1, 0, RECIPIENT, 123);
    }

    function testRobinhoodDeadlineUsesArbSysL2BlockNumber() public {
        vm.chainId(4663);
        vm.roll(9_999);
        _mockArbBlockNumber(700);
        PoolKey memory key;

        vm.expectRevert(abi.encodeWithSelector(LaypipeSwapRouter.TradeExpired.selector, 699, 700));
        router.buy(key, 1, 0, RECIPIENT, 699);

        vm.expectRevert(LaypipeSwapRouter.InvalidPool.selector);
        router.sell(key, 1, 0, RECIPIENT, 700);
    }

    function testRobinhoodDeadlineFailsClosedWithoutArbSys() public {
        vm.chainId(4663);
        PoolKey memory key;

        vm.expectRevert();
        router.buy(key, 1, 0, RECIPIENT, type(uint256).max);
    }

    function _mockArbBlockNumber(uint256 number) private {
        vm.etch(ARBSYS, abi.encodePacked(hex"7f", bytes32(number), hex"60005260206000f3"));
    }
}
