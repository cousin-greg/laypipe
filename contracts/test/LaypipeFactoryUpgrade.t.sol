// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LaypipeFactory} from "../src/LaypipeFactory.sol";
import {LaypipeToken} from "../src/LaypipeToken.sol";
import {LaypipeSelfBurner} from "../src/LaypipeSelfBurner.sol";
import {PipedogHook} from "../src/PipedogHook.sol";
import {MockERC20} from "./mocks/RevenueRouterMocks.sol";

contract PoolManagerCodeStub {}

contract NonUUPSImplementation {}

contract HookBindingStub {
    address public immutable factory;
    IPoolManager public immutable poolManager;
    IERC20 public immutable quoteToken;
    address public treasury;

    constructor(address factory_, IPoolManager poolManager_, IERC20 quoteToken_, address treasury_) {
        factory = factory_;
        poolManager = poolManager_;
        quoteToken = quoteToken_;
        treasury = treasury_;
    }

    function setTreasury(address treasury_) external {
        treasury = treasury_;
    }
}

contract SelfBurnerBindingStub {
    address public immutable factory;
    address public immutable hook;
    IPoolManager public immutable poolManager;
    IERC20 public immutable quoteToken;

    constructor(address factory_, address hook_, IPoolManager poolManager_, IERC20 quoteToken_) {
        factory = factory_;
        hook = hook_;
        poolManager = poolManager_;
        quoteToken = quoteToken_;
    }
}

contract LaypipeFactoryV2Mock is LaypipeFactory {
    uint256 public appendedValue;

    function initializeV2(uint256 value) external reinitializer(2) {
        appendedValue = value;
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}

contract LaypipeFactoryUpgradeTest is Test {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address internal constant TREASURY = address(0x7EA5);
    address internal constant NEW_TREASURY = address(0xBEEF);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant PENDING_OWNER = address(0xA11CE);
    address internal constant ATTACKER = address(0xBAD);
    uint256 internal constant LAUNCH_FEE = 0.0005 ether;

    PoolManagerCodeStub internal manager;
    MockERC20 internal quoteToken;
    LaypipeFactory internal implementation;
    LaypipeFactory internal factory;

    function setUp() public {
        manager = new PoolManagerCodeStub();
        quoteToken = new MockERC20("Pipedog", "PIPEDOG");
        implementation = new LaypipeFactory();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                LaypipeFactory.initialize,
                (IPoolManager(address(manager)), IERC20(address(quoteToken)), TREASURY, address(this), LAUNCH_FEE)
            )
        );
        factory = LaypipeFactory(address(proxy));
    }

    function testOwnershipHandoffControlsUpgradeAndPreservesStorage() public {
        LaypipeFactoryV2Mock next = new LaypipeFactoryV2Mock();
        bytes32 proxyCodehashBefore = address(factory).codehash;
        bytes32 nextCodehash = address(next).codehash;

        factory.transferOwnership(PENDING_OWNER);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", ATTACKER));
        vm.prank(ATTACKER);
        factory.upgradeToAndCall(address(next), "");

        // A nominated owner has no admin power until it explicitly accepts.
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", PENDING_OWNER));
        vm.prank(PENDING_OWNER);
        factory.upgradeToAndCall(address(next), "");

        vm.prank(PENDING_OWNER);
        factory.acceptOwnership();

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", address(this)));
        factory.upgradeToAndCall(address(next), "");

        vm.prank(PENDING_OWNER);
        factory.upgradeToAndCall(address(next), abi.encodeCall(LaypipeFactoryV2Mock.initializeV2, (42)));

        LaypipeFactoryV2Mock upgraded = LaypipeFactoryV2Mock(address(factory));
        assertEq(upgraded.version(), 2);
        assertEq(upgraded.appendedValue(), 42);
        assertEq(upgraded.owner(), PENDING_OWNER);
        assertEq(upgraded.pendingOwner(), address(0));
        assertEq(address(upgraded.poolManager()), address(manager));
        assertEq(address(upgraded.quoteToken()), address(quoteToken));
        assertEq(upgraded.treasury(), TREASURY);
        assertEq(upgraded.launchFee(), LAUNCH_FEE);
        assertFalse(upgraded.launchEnabled());

        address activeImplementation = address(uint160(uint256(vm.load(address(factory), IMPLEMENTATION_SLOT))));
        assertEq(activeImplementation, address(next));
        assertEq(activeImplementation.codehash, nextCodehash);
        assertEq(address(factory).codehash, proxyCodehashBefore);
        assertTrue(address(next).codehash != address(implementation).codehash);
    }

    function testUpgradeRequiresLaunchGateClosedAndLeavesSlotUntouched() public {
        LaypipeFactoryV2Mock next = new LaypipeFactoryV2Mock();
        bytes32 implementationBefore = vm.load(address(factory), IMPLEMENTATION_SLOT);

        // launchEnabled is the existing slot 7; no production-only test hook
        // is added merely to exercise this release invariant.
        vm.store(address(factory), bytes32(uint256(7)), bytes32(uint256(1)));
        assertTrue(factory.launchEnabled());

        vm.expectRevert(LaypipeFactory.UpgradeRequiresLaunchPaused.selector);
        factory.upgradeToAndCall(address(next), "");
        assertEq(vm.load(address(factory), IMPLEMENTATION_SLOT), implementationBefore);

        vm.store(address(factory), bytes32(uint256(7)), bytes32(0));
        factory.upgradeToAndCall(address(next), "");
        assertEq(address(uint160(uint256(vm.load(address(factory), IMPLEMENTATION_SLOT)))), address(next));
    }

    function testManifestSensitiveAdminMutationsRequireLaunchGateClosed() public {
        factory.addLaunchConfig(_config(true));
        factory.addLaunchConfig(_config(false));

        LaypipeToken nextTokenImplementation = new LaypipeToken();
        HookBindingStub nextHook = new HookBindingStub(
            address(factory), IPoolManager(address(manager)), IERC20(address(quoteToken)), TREASURY
        );
        SelfBurnerBindingStub nextSelfBurner = new SelfBurnerBindingStub(
            address(factory), address(nextHook), IPoolManager(address(manager)), IERC20(address(quoteToken))
        );

        quoteToken.mint(CREATOR, LAUNCH_FEE);
        vm.prank(CREATOR);
        quoteToken.approve(address(factory), LAUNCH_FEE);

        vm.store(address(factory), bytes32(uint256(7)), bytes32(uint256(1)));
        assertTrue(factory.launchEnabled());

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.addLaunchConfig(_config(false));

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setLaunchConfigEnabled(0, false);

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setLaunchConfigEnabled(1, true);

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setHook(PipedogHook(address(nextHook)));

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setTokenImplementation(nextTokenImplementation);

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setSelfBurner(LaypipeSelfBurner(address(nextSelfBurner)));

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setTreasury(NEW_TREASURY);

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setLaunchFee(LAUNCH_FEE + 1);

        assertEq(factory.launchConfigCount(), 2);
        assertTrue(factory.getLaunchConfig(0).enabled);
        assertFalse(factory.getLaunchConfig(1).enabled);
        assertEq(address(factory.hook()), address(0));
        assertEq(address(factory.tokenImplementation()), address(0));
        assertEq(address(factory.selfBurner()), address(0));
        assertEq(factory.treasury(), TREASURY);
        assertEq(factory.launchFee(), LAUNCH_FEE);
        assertEq(quoteToken.allowance(CREATOR, address(factory)), LAUNCH_FEE);

        vm.store(address(factory), bytes32(uint256(7)), bytes32(0));
        factory.addLaunchConfig(_config(false));
        factory.setLaunchConfigEnabled(0, false);
        factory.setLaunchConfigEnabled(1, true);
        factory.setHook(PipedogHook(address(nextHook)));
        factory.setTokenImplementation(nextTokenImplementation);
        factory.setSelfBurner(LaypipeSelfBurner(address(nextSelfBurner)));
        nextHook.setTreasury(NEW_TREASURY);
        factory.setTreasury(NEW_TREASURY);
        factory.setLaunchFee(LAUNCH_FEE + 1);

        assertEq(factory.launchConfigCount(), 3);
        assertFalse(factory.getLaunchConfig(0).enabled);
        assertTrue(factory.getLaunchConfig(1).enabled);
        assertEq(address(factory.hook()), address(nextHook));
        assertEq(address(factory.tokenImplementation()), address(nextTokenImplementation));
        assertEq(address(factory.selfBurner()), address(nextSelfBurner));
        assertEq(factory.treasury(), NEW_TREASURY);
        assertEq(factory.launchFee(), LAUNCH_FEE + 1);
    }

    function testHookRotationRequiresPriorPauseAndClearsBoundSelfBurner() public {
        HookBindingStub firstHook = new HookBindingStub(
            address(factory), IPoolManager(address(manager)), IERC20(address(quoteToken)), TREASURY
        );
        HookBindingStub nextHook = new HookBindingStub(
            address(factory), IPoolManager(address(manager)), IERC20(address(quoteToken)), TREASURY
        );
        SelfBurnerBindingStub firstSelfBurner = new SelfBurnerBindingStub(
            address(factory), address(firstHook), IPoolManager(address(manager)), IERC20(address(quoteToken))
        );

        factory.setHook(PipedogHook(address(firstHook)));
        factory.setSelfBurner(LaypipeSelfBurner(address(firstSelfBurner)));
        vm.store(address(factory), bytes32(uint256(7)), bytes32(uint256(1)));

        vm.expectRevert(LaypipeFactory.AdminMutationRequiresLaunchPaused.selector);
        factory.setHook(PipedogHook(address(nextHook)));

        assertTrue(factory.launchEnabled());
        assertEq(address(factory.hook()), address(firstHook));
        assertEq(address(factory.selfBurner()), address(firstSelfBurner));

        vm.store(address(factory), bytes32(uint256(7)), bytes32(0));
        factory.setHook(PipedogHook(address(nextHook)));

        assertFalse(factory.launchEnabled());
        assertEq(address(factory.hook()), address(nextHook));
        assertEq(address(factory.selfBurner()), address(0));
    }

    function testInvalidImplementationAndDirectCallsFailClosed() public {
        NonUUPSImplementation invalid = new NonUUPSImplementation();
        bytes32 implementationBefore = vm.load(address(factory), IMPLEMENTATION_SLOT);

        vm.expectRevert();
        factory.upgradeToAndCall(address(invalid), "");
        assertEq(vm.load(address(factory), IMPLEMENTATION_SLOT), implementationBefore);

        vm.expectRevert();
        implementation.initialize(
            IPoolManager(address(manager)), IERC20(address(quoteToken)), TREASURY, address(this), LAUNCH_FEE
        );

        LaypipeFactoryV2Mock next = new LaypipeFactoryV2Mock();
        vm.expectRevert();
        next.upgradeToAndCall(address(next), "");

        vm.expectRevert();
        factory.proxiableUUID();
    }

    function _config(bool enabled) private pure returns (LaypipeFactory.LaunchConfig memory) {
        return LaypipeFactory.LaunchConfig({
            supply: 1_000_000_000 ether,
            tickSpacing: 200,
            startTick: 204_200,
            creatorFeeBps: 7_000,
            baseFeeRate: 10_000,
            launchFeeRate: 10_000,
            launchFeeDecay: 0,
            enabled: enabled,
            selfBurn: false
        });
    }
}
