// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PipedogRevenueRouter} from "../src/PipedogRevenueRouter.sol";
import {IArbSysBlockNumber} from
    "../src/lib/ChainBlockNumber.sol";
import {FeeOnTransferERC20, MockERC20, ReentrantERC20, RejectNative} from "./mocks/RevenueRouterMocks.sol";

contract PipedogRevenueRouterTest is Test {
    address internal constant ARBSYS =
        0x0000000000000000000000000000000000000064;
    uint16 internal constant BOUNTY_BPS = 100;
    uint256 internal constant SEQUESTER_CAP = 100 ether;
    uint256 internal constant TREASURY_CAP = 100 ether;

    address internal constant DONOR = address(0xD0A0);
    address internal constant TREASURY = address(0xA11CE);
    address internal constant OPERATIONS = address(0xB0B);
    address internal constant KEEPER = address(0xCA11);
    address internal constant SUCCESSOR = address(0x5ACC);
    address internal constant RECIPIENT = address(0xD00D);

    MockERC20 internal pipedog;
    PipedogRevenueRouter internal router;

    function setUp() public {
        pipedog = new MockERC20("Pipedog", "PIPEDOG");
        router = _deployRouter(IERC20(address(pipedog)), SEQUESTER_CAP, TREASURY_CAP, BOUNTY_BPS);
        pipedog.mint(DONOR, 1_000_000 ether);
    }

    function testAllocateUsesExact252550PolicyIncludingRounding() public {
        _deposit(1 ether + 3);

        assertEq(router.sequesterTank(), 0.25 ether);
        assertEq(router.treasuryTank(), 0.25 ether);
        assertEq(router.operationsTab(), 0.5 ether + 3);
        assertEq(router.totalRevenueAllocated(), 1 ether + 3);
        assertEq(router.unallocated(), 0);

        // A seven-wei direct donation allocates 1 / 1 / 5. Operations
        // deliberately receives both rounding remainders.
        vm.prank(DONOR);
        pipedog.transfer(address(router), 7);
        assertEq(router.unallocated(), 7);
        router.allocate();

        assertEq(router.sequesterTank(), 0.25 ether + 1);
        assertEq(router.treasuryTank(), 0.25 ether + 1);
        assertEq(router.operationsTab(), 0.5 ether + 8);
        assertEq(router.totalRevenueAllocated(), 1 ether + 10);
        assertEq(router.unallocated(), 0);
        _assertAccountingIdentity(router, pipedog);
    }

    function testFuzzAllocationNeverLosesAWei(uint96 seed) public {
        uint256 amount = bound(uint256(seed), 1, 100_000 ether);
        _deposit(amount);

        uint256 expectedSequester = amount / 4;
        uint256 expectedTreasury = amount / 4;
        uint256 expectedOperations = amount - expectedSequester - expectedTreasury;

        assertEq(router.sequesterTank(), expectedSequester);
        assertEq(router.treasuryTank(), expectedTreasury);
        assertEq(router.operationsTab(), expectedOperations);
        assertEq(router.sequesterTank() + router.treasuryTank() + router.operationsTab(), amount);
        _assertAccountingIdentity(router, pipedog);
    }

    function testPermissionlessRoutesApplyCapsBountiesAndOncePerBlock() public {
        _deposit(800 ether);
        uint256 supplyBefore = pipedog.totalSupply();

        vm.prank(KEEPER);
        assertEq(router.sequesterPipedog(), 99 ether);
        assertEq(pipedog.balanceOf(router.SEQUESTER_SINK()), 99 ether);
        assertEq(pipedog.balanceOf(KEEPER), 1 ether);
        assertEq(router.sequesterTank(), 100 ether);

        vm.expectRevert(PipedogRevenueRouter.AlreadyProcessedThisBlock.selector);
        vm.prank(KEEPER);
        router.sequesterPipedog();

        // Each permissionless lane has an independent per-block guard.
        vm.prank(KEEPER);
        assertEq(router.routeTreasuryPipedog(), 99 ether);
        assertEq(pipedog.balanceOf(TREASURY), 99 ether);
        assertEq(pipedog.balanceOf(KEEPER), 2 ether);
        assertEq(router.treasuryTank(), 100 ether);

        vm.expectRevert(PipedogRevenueRouter.AlreadyProcessedThisBlock.selector);
        vm.prank(KEEPER);
        router.routeTreasuryPipedog();

        vm.roll(block.number + 1);
        vm.startPrank(KEEPER);
        assertEq(router.sequesterPipedog(), 99 ether);
        assertEq(router.routeTreasuryPipedog(), 99 ether);
        vm.stopPrank();

        assertEq(pipedog.balanceOf(router.SEQUESTER_SINK()), 198 ether);
        assertEq(pipedog.balanceOf(TREASURY), 198 ether);
        assertEq(pipedog.balanceOf(KEEPER), 4 ether);
        assertEq(router.totalPipedogSequestered(), 198 ether);
        assertEq(router.totalPipedogTreasuryRouted(), 198 ether);
        assertEq(router.totalKeeperBounties(), 4 ether);
        assertEq(router.sequesterTank(), 0);
        assertEq(router.treasuryTank(), 0);

        // Sending tokens to the conventional sink does not change ERC20
        // totalSupply.
        assertEq(pipedog.totalSupply(), supplyBefore);
        _assertAccountingIdentity(router, pipedog);
    }

    function testBountyRoundsDownWithoutOverdrawingGrossChunk() public {
        MockERC20 token = new MockERC20("Pipedog", "PIPEDOG");
        PipedogRevenueRouter localRouter = _deployRouter(IERC20(address(token)), 199, 199, 100);
        token.mint(DONOR, 796);

        vm.startPrank(DONOR);
        token.approve(address(localRouter), 796);
        localRouter.deposit(796);
        vm.stopPrank();

        vm.prank(KEEPER);
        assertEq(localRouter.sequesterPipedog(), 198);
        assertEq(token.balanceOf(localRouter.SEQUESTER_SINK()), 198);
        assertEq(token.balanceOf(KEEPER), 1);
        assertEq(localRouter.sequesterTank(), 0);
        assertEq(localRouter.totalKeeperBounties(), 1);
        _assertAccountingIdentity(localRouter, token);
    }

    function testRobinhoodPerBlockGuardUsesArbSysBlockNumber() public {
        vm.chainId(4663);
        _mockArbBlockNumber(700);
        _deposit(800 ether);

        vm.prank(KEEPER);
        router.sequesterPipedog();

        // Robinhood's Solidity block.number is an L1 estimate. Moving it does
        // not open another L2-block keeper slot.
        vm.roll(block.number + 1);
        vm.expectRevert(
            PipedogRevenueRouter.AlreadyProcessedThisBlock.selector
        );
        vm.prank(KEEPER);
        router.sequesterPipedog();

        _mockArbBlockNumber(701);
        vm.prank(KEEPER);
        assertEq(router.sequesterPipedog(), 99 ether);
    }

    function testOperationsCollectionPaysPipedogToFixedDestination() public {
        _deposit(100 ether);
        vm.prank(KEEPER);
        assertEq(router.collectOperations(), 50 ether);

        assertEq(pipedog.balanceOf(OPERATIONS), 50 ether);
        assertEq(router.totalPipedogOperationsCollected(), 50 ether);
        assertEq(router.operationsTab(), 0);
        assertEq(router.collectOperations(), 0);
        assertEq(OPERATIONS.balance, 0);
        _assertAccountingIdentity(router, pipedog);
    }

    function testPauseStopsRoutingButNotDepositsOrOperations() public {
        _deposit(400 ether);
        router.pause();

        vm.expectRevert();
        router.sequesterPipedog();
        vm.expectRevert();
        router.routeTreasuryPipedog();

        // Pausing keeper routes does not strand incoming revenue or the
        // operations lane.
        _deposit(100 ether);
        assertEq(router.collectOperations(), 250 ether);

        router.unpause();
        assertEq(router.sequesterPipedog(), 99 ether);
        assertEq(router.routeTreasuryPipedog(), 99 ether);
        _assertAccountingIdentity(router, pipedog);
    }

    function testOnlyOwnerCanChangeDestinationsCapsAndPause() public {
        vm.startPrank(KEEPER);
        vm.expectRevert();
        router.setTreasury(address(1));
        vm.expectRevert();
        router.setOperationsWallet(address(1));
        vm.expectRevert();
        router.setMaxSequesterPerCall(1);
        vm.expectRevert();
        router.setMaxTreasuryRoutePerCall(1);
        vm.expectRevert();
        router.pause();
        vm.expectRevert();
        router.migrate(SUCCESSOR);
        vm.stopPrank();

        router.setTreasury(address(0x1234));
        router.setOperationsWallet(address(0x5678));
        router.setMaxSequesterPerCall(0.2 ether);
        router.setMaxTreasuryRoutePerCall(0.3 ether);

        assertEq(router.treasury(), address(0x1234));
        assertEq(router.operationsWallet(), address(0x5678));
        assertEq(router.maxSequesterPerCall(), 0.2 ether);
        assertEq(router.maxTreasuryRoutePerCall(), 0.3 ether);

        vm.expectRevert(PipedogRevenueRouter.ZeroAddress.selector);
        router.setTreasury(address(router));
        vm.expectRevert(PipedogRevenueRouter.ZeroAddress.selector);
        router.setOperationsWallet(address(0));
        vm.expectRevert(PipedogRevenueRouter.ZeroCap.selector);
        router.setMaxSequesterPerCall(0);
        vm.expectRevert(PipedogRevenueRouter.ZeroCap.selector);
        router.setMaxTreasuryRoutePerCall(0);
    }

    function testMigrationAllocatesFreshDonationAndPreservesAccounting() public {
        _deposit(400 ether);
        PipedogRevenueRouter successor =
            _deployRouter(
                IERC20(address(pipedog)),
                SEQUESTER_CAP,
                TREASURY_CAP,
                BOUNTY_BPS
            );

        // Regression: migration must allocate direct PIPEDOG transfers before
        // clearing the pots, or totalMigrated can exceed accounted revenue.
        vm.prank(DONOR);
        pipedog.transfer(address(router), 3);
        assertEq(router.unallocated(), 3);
        assertEq(router.totalRevenueAllocated(), 400 ether);

        router.pause();
        router.migrate(address(successor));

        assertEq(
            pipedog.balanceOf(address(successor)), 400 ether + 3
        );
        assertEq(successor.unallocated(), 400 ether + 3);
        assertEq(pipedog.balanceOf(address(router)), 0);
        assertEq(router.sequesterTank(), 0);
        assertEq(router.treasuryTank(), 0);
        assertEq(router.operationsTab(), 0);
        assertEq(router.totalRevenueAllocated(), 400 ether + 3);
        assertEq(router.totalMigrated(), 400 ether + 3);
        assertEq(router.unallocated(), 0);
        _assertAccountingIdentity(router, pipedog);
    }

    function testMigrationRequiresPauseAndCompatiblePipedogRouter()
        public
    {
        PipedogRevenueRouter successor =
            _deployRouter(
                IERC20(address(pipedog)),
                SEQUESTER_CAP,
                TREASURY_CAP,
                BOUNTY_BPS
            );

        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        router.migrate(address(successor));

        router.pause();
        vm.expectRevert(PipedogRevenueRouter.InvalidSuccessor.selector);
        router.migrate(SUCCESSOR);

        MockERC20 wrongToken = new MockERC20("Wrong", "WRONG");
        PipedogRevenueRouter wrongTokenRouter =
            _deployRouter(
                IERC20(address(wrongToken)),
                SEQUESTER_CAP,
                TREASURY_CAP,
                BOUNTY_BPS
            );
        vm.expectRevert(PipedogRevenueRouter.InvalidSuccessor.selector);
        router.migrate(address(wrongTokenRouter));

        vm.expectRevert(PipedogRevenueRouter.ZeroAddress.selector);
        router.migrate(address(router));
        vm.expectRevert(PipedogRevenueRouter.ZeroAddress.selector);
        router.migrate(address(0));
    }

    function testRecoveryProtectsPipedogAndHandlesUnrelatedAssets() public {
        MockERC20 accidental = new MockERC20("Accidental", "OOPS");
        accidental.mint(address(router), 77 ether);

        router.recoverToken(IERC20(address(accidental)), RECIPIENT);
        assertEq(accidental.balanceOf(RECIPIENT), 77 ether);

        vm.expectRevert(PipedogRevenueRouter.ProtectedToken.selector);
        router.recoverToken(IERC20(address(pipedog)), RECIPIENT);

        vm.deal(address(router), 2 ether);
        router.recoverNative(payable(RECIPIENT));
        assertEq(RECIPIENT.balance, 2 ether);
        assertEq(address(router).balance, 0);

        // The router has no operational native-value entry point.
        vm.deal(address(this), 1 ether);
        (bool accepted,) = address(router).call{value: 1}("");
        assertFalse(accepted);
    }

    function testNativeRecoveryFailureRevertsWithoutLosingFunds() public {
        RejectNative rejector = new RejectNative();
        vm.deal(address(router), 1 ether);

        vm.expectRevert(PipedogRevenueRouter.NativeRecoveryFailed.selector);
        router.recoverNative(payable(address(rejector)));
        assertEq(address(router).balance, 1 ether);
    }

    function testFeeOnTransferPipedogFailsExactPullAndPushChecks() public {
        FeeOnTransferERC20 taxed = new FeeOnTransferERC20(100);
        PipedogRevenueRouter localRouter = _deployRouter(IERC20(address(taxed)), 100, 100, 0);
        taxed.mint(DONOR, 400);

        vm.startPrank(DONOR);
        taxed.approve(address(localRouter), 100);
        vm.expectRevert(abi.encodeWithSelector(PipedogRevenueRouter.QuoteTransferMismatch.selector, 100, 99));
        localRouter.deposit(100);
        vm.stopPrank();

        assertEq(taxed.balanceOf(DONOR), 400);
        assertEq(taxed.balanceOf(address(localRouter)), 0);

        // Minting directly to the router bypasses the pull check and exercises
        // the symmetric outgoing exact-transfer guard.
        taxed.mint(address(localRouter), 400);
        localRouter.allocate();
        vm.expectRevert(abi.encodeWithSelector(PipedogRevenueRouter.QuoteTransferMismatch.selector, 100, 99));
        localRouter.sequesterPipedog();
        assertEq(taxed.balanceOf(address(localRouter)), 400);
        assertEq(localRouter.sequesterTank(), 100);
    }

    function testDepositBlocksTokenCallbackReentrancy() public {
        ReentrantERC20 reentrant = new ReentrantERC20();
        PipedogRevenueRouter localRouter = _deployRouter(IERC20(address(reentrant)), 100 ether, 100 ether, 0);
        reentrant.mint(DONOR, 100 ether);
        reentrant.configureReentry(address(localRouter));
        reentrant.armReentry();

        vm.startPrank(DONOR);
        reentrant.approve(address(localRouter), 100 ether);
        localRouter.deposit(100 ether);
        vm.stopPrank();

        assertTrue(reentrant.reentryAttempted());
        assertFalse(reentrant.reentrySucceeded());
        assertEq(reentrant.reentryRevertSelector(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(reentrant.balanceOf(address(localRouter)), 100 ether);
        assertEq(localRouter.totalRevenueAllocated(), 100 ether);
        assertEq(reentrant.allowance(DONOR, address(localRouter)), 0);
    }

    function testConstructorRejectsInvalidPolicyInputs() public {
        vm.expectRevert(PipedogRevenueRouter.ZeroAddress.selector);
        new PipedogRevenueRouter(IERC20(address(0xBEEF)), TREASURY, OPERATIONS, 1, 1, 0, address(this));

        vm.expectRevert(PipedogRevenueRouter.ZeroCap.selector);
        new PipedogRevenueRouter(IERC20(address(pipedog)), TREASURY, OPERATIONS, 0, 1, 0, address(this));

        vm.expectRevert(PipedogRevenueRouter.InvalidBounty.selector);
        new PipedogRevenueRouter(IERC20(address(pipedog)), TREASURY, OPERATIONS, 1, 1, 1_001, address(this));
    }

    function _deposit(uint256 amount) internal {
        vm.startPrank(DONOR);
        pipedog.approve(address(router), amount);
        router.deposit(amount);
        assertEq(pipedog.allowance(DONOR, address(router)), 0);
        vm.stopPrank();
    }

    function _deployRouter(IERC20 token, uint256 sequesterCap, uint256 treasuryCap, uint16 bountyBps)
        internal
        returns (PipedogRevenueRouter deployed)
    {
        deployed = new PipedogRevenueRouter(
            token, TREASURY, OPERATIONS, sequesterCap, treasuryCap, bountyBps, address(this)
        );
    }

    function _assertAccountingIdentity(PipedogRevenueRouter target, IERC20 token) internal view {
        uint256 accountedInbound = target.totalRevenueAllocated() + target.unallocated();
        uint256 heldOrRouted = token.balanceOf(address(target)) + target.totalPipedogSequestered()
            + target.totalPipedogTreasuryRouted() + target.totalPipedogOperationsCollected()
            + target.totalKeeperBounties() + target.totalMigrated();
        assertEq(accountedInbound, heldOrRouted);
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

contract RevenueRouterHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockERC20 internal immutable pipedog;
    PipedogRevenueRouter internal immutable router;

    constructor(MockERC20 pipedog_, PipedogRevenueRouter router_) {
        pipedog = pipedog_;
        router = router_;
    }

    function deposit(uint96 seed) external {
        uint256 amount = (uint256(seed) % 1_000 ether) + 1;
        if (pipedog.balanceOf(address(this)) < amount) return;
        pipedog.approve(address(router), amount);
        router.deposit(amount);
    }

    function donate(uint96 seed) external {
        uint256 amount = (uint256(seed) % 1_000 ether) + 1;
        if (pipedog.balanceOf(address(this)) < amount) return;
        pipedog.transfer(address(router), amount);
    }

    function allocate() external {
        router.allocate();
    }

    function sequester(uint8 jump) external {
        vm.roll(block.number + 1 + uint256(jump % 3));
        try router.sequesterPipedog() {} catch {}
    }

    function routeTreasury(uint8 jump) external {
        vm.roll(block.number + 1 + uint256(jump % 3));
        try router.routeTreasuryPipedog() {} catch {}
    }

    function collectOperations() external {
        try router.collectOperations() {} catch {}
    }
}

contract PipedogRevenueRouterInvariantTest is StdInvariant, Test {
    address internal constant TREASURY = address(0xA11CE);
    address internal constant OPERATIONS = address(0xB0B);

    MockERC20 internal pipedog;
    PipedogRevenueRouter internal router;
    RevenueRouterHandler internal handler;
    uint256 internal initialSupply;

    function setUp() public {
        pipedog = new MockERC20("Pipedog", "PIPEDOG");
        router = new PipedogRevenueRouter(
            IERC20(address(pipedog)), TREASURY, OPERATIONS, 1_000 ether, 1_000 ether, 100, address(this)
        );
        handler = new RevenueRouterHandler(pipedog, router);
        pipedog.mint(address(handler), type(uint128).max);
        initialSupply = pipedog.totalSupply();
        targetContract(address(handler));
    }

    function invariantEveryAllocatedWeiIsHeldOrRecordedAsOutflow() public view {
        uint256 accountedInbound = router.totalRevenueAllocated() + router.unallocated();
        uint256 heldOrRouted = pipedog.balanceOf(address(router)) + router.totalPipedogSequestered()
            + router.totalPipedogTreasuryRouted() + router.totalPipedogOperationsCollected()
            + router.totalKeeperBounties() + router.totalMigrated();
        assertEq(accountedInbound, heldOrRouted);
    }

    function invariantPotsAndFreshRevenueExactlyEqualRouterBalance() public view {
        uint256 accountedBalance =
            router.sequesterTank() + router.treasuryTank() + router.operationsTab() + router.unallocated();
        assertEq(accountedBalance, pipedog.balanceOf(address(router)));
    }

    function invariantDestinationsMatchCumulativeRouting() public view {
        assertEq(pipedog.balanceOf(router.SEQUESTER_SINK()), router.totalPipedogSequestered());
        assertEq(pipedog.balanceOf(TREASURY), router.totalPipedogTreasuryRouted());
        assertEq(pipedog.balanceOf(OPERATIONS), router.totalPipedogOperationsCollected());
    }

    function invariantSequestrationNeverChangesTotalSupply() public view {
        assertEq(pipedog.totalSupply(), initialSupply);
    }

    function invariantRevenueSharesAreImmutable() public view {
        assertEq(router.SEQUESTER_SHARE_BPS(), 2_500);
        assertEq(router.TREASURY_SHARE_BPS(), 2_500);
        assertEq(router.OPERATIONS_SHARE_BPS(), 5_000);
    }
}
