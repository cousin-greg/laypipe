// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LaypipeFactory} from "../src/LaypipeFactory.sol";
import {MockERC20} from "./mocks/RevenueRouterMocks.sol";

contract PoolManagerCodeStub {}

contract NonUUPSImplementation {}

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
}
