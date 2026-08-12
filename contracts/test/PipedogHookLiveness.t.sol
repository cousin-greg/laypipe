// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PipedogHook} from "../src/PipedogHook.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";

contract SelectiveRejectERC20 is ERC20 {
    error RejectedDestination(address sender, address recipient);

    mapping(bytes32 transferKey => bool rejected) public rejectedTransfer;

    constructor() ERC20("Pipedog", "PIPEDOG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function rejectTransfer(address sender, address recipient) external {
        rejectedTransfer[keccak256(abi.encode(sender, recipient))] = true;
    }

    function allowTransfer(address sender, address recipient) external {
        rejectedTransfer[keccak256(abi.encode(sender, recipient))] = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (rejectedTransfer[keccak256(abi.encode(from, to))]) {
            revert RejectedDestination(from, to);
        }
        super._update(from, to, value);
    }
}

contract HookPayoutPoolManager {
    using SafeERC20 for IERC20;

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function burn(address, uint256, uint256) external {}

    function take(Currency currency, address to, uint256 amount) external {
        IERC20(Currency.unwrap(currency)).safeTransfer(to, amount);
    }
}

contract PipedogHookHarness is PipedogHook {
    constructor(IPoolManager poolManager_, address factory_, IERC20 quoteToken_, address treasury_, address owner_)
        PipedogHook(poolManager_, factory_, quoteToken_, treasury_, owner_)
    {}

    function setPendingForTest(PoolId poolId, uint256 amount) external {
        pending[poolId] = amount;
    }
}

contract PipedogHookLivenessTest is Test {
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BAD_TREASURY = address(0xBAD);
    address internal constant GOOD_TREASURY = address(0x600D);
    address internal constant KEEPER = address(0xCA11);
    uint256 internal constant FEES = 100 ether;

    SelectiveRejectERC20 internal pipedog;
    HookPayoutPoolManager internal manager;
    PipedogHookHarness internal hook;
    PoolId internal poolId;
    bool public launchEnabled;

    function setUp() public {
        pipedog = new SelectiveRejectERC20();
        manager = new HookPayoutPoolManager();
        hook = _deployHook();
        poolId = PoolId.wrap(keccak256("platform-transfer-liveness"));

        hook.register(poolId, CREATOR, 7_000, 10_000, 10_000, 0);
        hook.setPendingForTest(poolId, FEES);
        pipedog.mint(address(manager), FEES);
        pipedog.rejectTransfer(address(hook), BAD_TREASURY);
    }

    function testTreasuryCannotRotateWhileFactoryLaunchGateIsOpen() public {
        launchEnabled = true;

        vm.expectRevert(PipedogHook.FactoryLaunchActive.selector);
        hook.setTreasury(GOOD_TREASURY);

        assertEq(hook.treasury(), BAD_TREASURY);

        launchEnabled = false;
        hook.setTreasury(GOOD_TREASURY);
        assertEq(hook.treasury(), GOOD_TREASURY);
    }

    function testRejectedPlatformTransferCannotFreezeCreatorClaim() public {
        vm.prank(CREATOR);
        uint256 claimed = hook.claim(poolId);

        assertEq(claimed, 70 ether);
        assertEq(pipedog.balanceOf(CREATOR), 70 ether);
        assertEq(hook.pending(poolId), 0);
        assertEq(hook.tab(poolId), 0);
        assertEq(hook.platformTab(), 30 ether);
        assertEq(pipedog.balanceOf(address(hook)), 30 ether);

        vm.expectRevert(
            abi.encodeWithSelector(SelectiveRejectERC20.RejectedDestination.selector, address(hook), BAD_TREASURY)
        );
        vm.prank(KEEPER);
        hook.collectPlatform();

        // The failed platform route rolls back only its own CEI state update.
        assertEq(hook.platformTab(), 30 ether);
        assertEq(pipedog.balanceOf(address(hook)), 30 ether);
        assertEq(pipedog.balanceOf(CREATOR), 70 ether);

        hook.setTreasury(GOOD_TREASURY);
        vm.prank(KEEPER);
        assertEq(hook.collectPlatform(), 30 ether);

        assertEq(hook.platformTab(), 0);
        assertEq(pipedog.balanceOf(address(hook)), 0);
        assertEq(pipedog.balanceOf(GOOD_TREASURY), 30 ether);
        assertEq(pipedog.balanceOf(BAD_TREASURY), 0);
        vm.prank(KEEPER);
        assertEq(hook.collectPlatform(), 0);
    }

    function testHealthyPlatformRoutePushesImmediatelyWithoutTab() public {
        hook.setTreasury(GOOD_TREASURY);

        vm.prank(CREATOR);
        assertEq(hook.claim(poolId), 70 ether);

        assertEq(pipedog.balanceOf(CREATOR), 70 ether);
        assertEq(pipedog.balanceOf(GOOD_TREASURY), 30 ether);
        assertEq(hook.platformTab(), 0);
        assertEq(pipedog.balanceOf(address(hook)), 0);
    }

    function testCreatorTransferFailureRollsBackCombinedSweepAccounting() public {
        pipedog.rejectTransfer(address(hook), CREATOR);

        vm.expectRevert(
            abi.encodeWithSelector(SelectiveRejectERC20.RejectedDestination.selector, address(hook), CREATOR)
        );
        vm.prank(CREATOR);
        hook.claim(poolId);

        assertEq(hook.pending(poolId), FEES);
        assertEq(hook.tab(poolId), 0);
        assertEq(hook.platformTab(), 0);
        assertEq(pipedog.balanceOf(address(manager)), FEES);
        assertEq(pipedog.balanceOf(address(hook)), 0);

        pipedog.allowTransfer(address(hook), CREATOR);
        vm.prank(CREATOR);
        assertEq(hook.claim(poolId), 70 ether);
        assertEq(hook.platformTab(), 30 ether);
    }

    function testCreatorFailureRollsBackSuccessfulPlatformPush() public {
        hook.setTreasury(GOOD_TREASURY);
        pipedog.rejectTransfer(address(hook), CREATOR);

        vm.expectRevert(
            abi.encodeWithSelector(SelectiveRejectERC20.RejectedDestination.selector, address(hook), CREATOR)
        );
        vm.prank(CREATOR);
        hook.claim(poolId);

        assertEq(hook.pending(poolId), FEES);
        assertEq(hook.tab(poolId), 0);
        assertEq(hook.platformTab(), 0);
        assertEq(pipedog.balanceOf(address(manager)), FEES);
        assertEq(pipedog.balanceOf(address(hook)), 0);
        assertEq(pipedog.balanceOf(GOOD_TREASURY), 0);
        assertEq(pipedog.balanceOf(CREATOR), 0);
    }

    function testCreatorTransferFailureAfterSweepPreservesBothTabs() public {
        (uint256 creatorAmount, uint256 platformAmount) = hook.sweep(poolId);
        assertEq(creatorAmount, 70 ether);
        assertEq(platformAmount, 30 ether);

        pipedog.rejectTransfer(address(hook), CREATOR);
        vm.expectRevert(
            abi.encodeWithSelector(SelectiveRejectERC20.RejectedDestination.selector, address(hook), CREATOR)
        );
        vm.prank(CREATOR);
        hook.claim(poolId);

        assertEq(hook.pending(poolId), 0);
        assertEq(hook.tab(poolId), 70 ether);
        assertEq(hook.platformTab(), 30 ether);
        assertEq(pipedog.balanceOf(address(hook)), FEES);

        pipedog.allowTransfer(address(hook), CREATOR);
        vm.prank(CREATOR);
        assertEq(hook.claim(poolId), 70 ether);
        assertEq(hook.platformTab(), 30 ether);
        assertEq(pipedog.balanceOf(address(hook)), 30 ether);
    }

    function testPoolManagerRedemptionFailureLeavesAccountingUntouched() public {
        vm.prank(address(manager));
        assertTrue(pipedog.transfer(address(0xDE1), 1 ether));

        vm.expectRevert();
        hook.sweep(poolId);

        assertEq(hook.pending(poolId), FEES);
        assertEq(hook.tab(poolId), 0);
        assertEq(hook.platformTab(), 0);
        assertEq(pipedog.balanceOf(address(manager)), FEES - 1 ether);
        assertEq(pipedog.balanceOf(address(hook)), 0);
    }

    function testPlatformExactTransferAdapterIsSelfOnly() public {
        vm.expectRevert(PipedogHook.NotSelf.selector);
        vm.prank(KEEPER);
        hook.pushPlatformExact(GOOD_TREASURY, 1);
    }

    function _deployHook() private returns (PipedogHookHarness deployed) {
        bytes memory args = abi.encode(
            IPoolManager(address(manager)), address(this), IERC20(address(pipedog)), BAD_TREASURY, address(this)
        );
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), _requiredFlags(), type(PipedogHookHarness).creationCode, args);
        deployed = new PipedogHookHarness{salt: salt}(
            IPoolManager(address(manager)), address(this), IERC20(address(pipedog)), BAD_TREASURY, address(this)
        );
        assertEq(address(deployed), predicted);
        Hooks.validateHookPermissions(IHooks(address(deployed)), deployed.getHookPermissions());
    }

    function _requiredFlags() private pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }
}
