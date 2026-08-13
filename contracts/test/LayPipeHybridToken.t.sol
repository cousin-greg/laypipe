// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {DN404} from "dn404/DN404.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {LayPipeHybridToken} from "../src/LayPipeHybridToken.sol";
import {PipeDogRewards} from "../src/PipeDogRewards.sol";

contract MockPipedogHybrid is ERC20 {
    constructor() ERC20("PipeDog", "PIPEDOG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SystemHolder {
    address public poolManager;
    address public pipedog;
    address public laypipeToken;
    address public hook;
    bytes32 public configuredPoolId;

    function bind(address poolManager_, address pipedog_, address token_, address hook_, bytes32 poolId_) external {
        poolManager = poolManager_;
        pipedog = pipedog_;
        laypipeToken = token_;
        hook = hook_;
        configuredPoolId = poolId_;
    }

    function send(IERC20 token, address to, uint256 amount) external {
        token.transfer(to, amount);
    }

    function pull(IERC20 token, address from, uint256 amount) external {
        require(token.transferFrom(from, address(this), amount));
    }
}

contract CodeOnly {}

contract BindingRouterMock {
    address public poolManager;
    address public pipedog;
    address public laypipeToken;
    address public hook;
    address public launcher;
    bytes32 public poolId;

    function bind(
        address poolManager_,
        address pipedog_,
        address token_,
        address hook_,
        address launcher_,
        bytes32 poolId_
    ) external {
        poolManager = poolManager_;
        pipedog = pipedog_;
        laypipeToken = token_;
        hook = hook_;
        launcher = launcher_;
        poolId = poolId_;
    }
}

contract RewardPoolManagerMock {
    using CurrencyLibrary for Currency;

    bool private _unlocked;
    mapping(address => mapping(uint256 => uint256)) public claimBalance;

    function mint(address to, uint256 id, uint256 amount) external {
        claimBalance[to][id] += amount;
    }

    function burn(address from, uint256 id, uint256 amount) external {
        require(_unlocked);
        claimBalance[from][id] -= amount;
    }

    function take(Currency currency, address to, uint256 amount) external {
        require(_unlocked);
        IERC20(Currency.unwrap(currency)).transfer(to, amount);
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!_unlocked);
        _unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        _unlocked = false;
    }

    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return claimBalance[owner][id];
    }

    function fundUnderlying(IERC20 token, address from, uint256 amount) external {
        token.transferFrom(from, address(this), amount);
    }
}

contract RewardNotifierMock {
    PipeDogRewards public immutable vault;
    RewardPoolManagerMock public immutable manager;
    address public launcher;
    address public canonicalRouter;

    constructor(PipeDogRewards vault_, RewardPoolManagerMock manager_) {
        vault = vault_;
        manager = manager_;
    }

    function notify(uint256 amount) external {
        manager.mint(address(vault), vault.pipedogClaimId(), amount);
        vault.notifyRewardClaim(amount);
    }

    function notifyWithoutFunding(uint256 amount) external {
        vault.notifyRewardClaim(amount);
    }

    function bind(address launcher_, address router_) external {
        launcher = launcher_;
        canonicalRouter = router_;
    }

    function poolManager() external view returns (address) {
        return address(manager);
    }

    function pipedog() external view returns (address) {
        return address(vault.pipedog());
    }

    function rewardVault() external view returns (address) {
        return address(vault);
    }

    function configurator() external view returns (address) {
        return vault.configurator();
    }
}

contract LayPipeHybridTokenHarness is LayPipeHybridToken {
    constructor(address initialSupplyOwner_, IERC20 pipedog_, IPoolManager poolManager_, address configurator_)
        LayPipeHybridToken(initialSupplyOwner_, pipedog_, poolManager_, configurator_, "")
    {}

    function forceMintForConfigTest(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract LayPipeHybridTokenTest is Test {
    uint256 private constant UNIT = 100_000 ether;

    MockPipedogHybrid private pipedog;
    LayPipeHybridToken private token;
    PipeDogRewards private vault;
    DN404Mirror private mirror;
    RewardNotifierMock private notifier;
    RewardPoolManagerMock private manager;
    SystemHolder private launcher;
    BindingRouterMock private router;

    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    function setUp() public {
        pipedog = new MockPipedogHybrid();
        manager = new RewardPoolManagerMock();
        token = new LayPipeHybridToken(
            address(this), pipedog, IPoolManager(address(manager)), address(this), "ipfs://pipedogs/"
        );
        vault = token.rewardVault();
        mirror = DN404Mirror(payable(token.mirrorERC721()));
        notifier = new RewardNotifierMock(vault, manager);
        launcher = new SystemHolder();
        router = new BindingRouterMock();

        _bindSystem(token, vault, manager, notifier, launcher, router);

        vault.setRewardNotifier(address(notifier));
        token.configureSystemExclusions(address(launcher), address(notifier), address(manager), address(router));

        token.approve(address(launcher), token.totalSupply());
        launcher.pull(IERC20(address(token)), address(this), token.totalSupply());
        token.releaseInitialSupplyOwner();
        pipedog.mint(address(this), 1_000_000_000 ether);
        pipedog.approve(address(manager), type(uint256).max);
        manager.fundUnderlying(pipedog, address(this), 1_000_000_000 ether);
    }

    function _bindSystem(
        LayPipeHybridToken token_,
        PipeDogRewards vault_,
        RewardPoolManagerMock manager_,
        RewardNotifierMock hook_,
        SystemHolder launcher_,
        BindingRouterMock router_
    ) private {
        bytes32 id = keccak256(abi.encode(address(token_), address(vault_)));
        launcher_.bind(address(manager_), address(vault_.pipedog()), address(token_), address(hook_), id);
        router_.bind(
            address(manager_), address(vault_.pipedog()), address(token_), address(hook_), address(launcher_), id
        );
        hook_.bind(address(launcher_), address(router_));
    }

    function testFixedSupplyAndERC7631Mirror() public view {
        assertEq(token.name(), "LayPipe");
        assertEq(token.symbol(), "LAYPIPE");
        assertEq(token.decimals(), 18);
        assertEq(token.INITIAL_SUPPLY(), 1_000_000_000 ether);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.NFT_UNIT(), UNIT);
        assertEq(token.MAX_NFT_SUPPLY(), 10_000);
        assertEq(token.totalSupply() / token.NFT_UNIT(), token.MAX_NFT_SUPPLY());
        assertEq(mirror.baseERC20(), address(token));
        assertEq(mirror.name(), "PipeDogs");
        assertEq(mirror.symbol(), "PIPEDOGNFT");
        assertEq(mirror.totalSupply(), 0);
    }

    function testAutomaticThresholdAndMetadata() public {
        launcher.send(IERC20(address(token)), alice, UNIT - 1);
        assertEq(mirror.balanceOf(alice), 0);
        assertEq(vault.eligibleUnitsOf(alice), 0);

        launcher.send(IERC20(address(token)), alice, 1);
        assertEq(mirror.balanceOf(alice), 1);
        assertEq(vault.eligibleUnitsOf(alice), 1);
        assertEq(mirror.ownerOf(1), alice);
        assertEq(mirror.tokenURI(1), "ipfs://pipedogs/1");

        launcher.send(IERC20(address(token)), alice, 2 * UNIT);
        assertEq(mirror.balanceOf(alice), 3);
        assertEq(vault.eligibleUnitsOf(alice), 3);
        assertEq(vault.totalEligibleUnits(), 3);
    }

    function testBelowThresholdEarnsNothingAndWholeUnitsAreWeighted() public {
        launcher.send(IERC20(address(token)), alice, UNIT - 1);
        launcher.send(IERC20(address(token)), bob, 3 * UNIT);
        notifier.notify(300 ether);

        assertEq(vault.claimable(alice), 0);
        assertEq(vault.claimable(bob), 300 ether);
    }

    function testAccruedRewardsSurviveUnitIncrease() public {
        launcher.send(IERC20(address(token)), alice, UNIT);
        launcher.send(IERC20(address(token)), bob, 3 * UNIT);
        notifier.notify(400 ether);

        launcher.send(IERC20(address(token)), alice, UNIT);
        notifier.notify(400 ether);

        assertEq(vault.claimable(alice), 260 ether);
        assertEq(vault.claimable(bob), 540 ether);

        vm.prank(alice);
        assertEq(vault.claim(), 260 ether);
        vm.prank(bob);
        assertEq(vault.claim(), 540 ether);
        assertEq(pipedog.balanceOf(alice), 260 ether);
        assertEq(pipedog.balanceOf(bob), 540 ether);
    }

    function testAccruedRewardsSurviveDroppingBelowAndRegainingThreshold() public {
        launcher.send(IERC20(address(token)), alice, UNIT);
        launcher.send(IERC20(address(token)), bob, UNIT);
        notifier.notify(200 ether);

        vm.prank(alice);
        token.transfer(bob, 1);
        assertEq(vault.eligibleUnitsOf(alice), 0);
        assertEq(vault.claimable(alice), 100 ether);

        notifier.notify(100 ether);
        vm.prank(bob);
        token.transfer(alice, 1);
        notifier.notify(200 ether);

        assertEq(vault.eligibleUnitsOf(alice), 1);
        assertEq(vault.claimable(alice), 200 ether);
        assertEq(vault.claimable(bob), 300 ether);
    }

    function testNFTTransferMovesOneUnitAndPreservesOldRewards() public {
        launcher.send(IERC20(address(token)), alice, UNIT);
        launcher.send(IERC20(address(token)), bob, UNIT);
        notifier.notify(200 ether);

        vm.prank(alice);
        mirror.transferFrom(alice, bob, 1);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), 2 * UNIT);
        assertEq(vault.eligibleUnitsOf(alice), 0);
        assertEq(vault.eligibleUnitsOf(bob), 2);
        assertEq(vault.claimable(alice), 100 ether);
        assertEq(vault.claimable(bob), 100 ether);

        notifier.notify(300 ether);
        assertEq(vault.claimable(alice), 100 ether);
        assertEq(vault.claimable(bob), 400 ether);
    }

    function testExcludedSystemAddressesNeverReceiveNFTsOrRewards() public {
        launcher.send(IERC20(address(token)), address(manager), 100 * UNIT);
        assertEq(mirror.balanceOf(address(launcher)), 0);
        assertEq(mirror.balanceOf(address(manager)), 0);
        assertEq(vault.eligibleUnitsOf(address(launcher)), 0);
        assertEq(vault.eligibleUnitsOf(address(manager)), 0);
        assertEq(vault.totalEligibleUnits(), 0);

        notifier.notify(100 ether);
        assertEq(vault.claimable(address(launcher)), 0);
        assertEq(vault.claimable(address(manager)), 0);
        assertEq(vault.undistributedRewards(), 100 ether);
    }

    function testRewardsCollectedBeforeFirstHolderGoToFirstEligibleUnit() public {
        notifier.notify(100 ether);
        assertEq(vault.undistributedRewards(), 100 ether);

        launcher.send(IERC20(address(token)), alice, UNIT);
        assertEq(vault.undistributedRewards(), 0);
        assertEq(vault.claimable(alice), 100 ether);
    }

    function testInitialSupplyWalletCanBuyAfterInventoryLeaves() public {
        assertFalse(token.isExcluded(address(this)));
        assertFalse(token.getSkipNFT(address(this)));

        launcher.send(IERC20(address(token)), address(this), UNIT);
        assertEq(mirror.balanceOf(address(this)), 1);
        assertEq(vault.eligibleUnitsOf(address(this)), 1);
    }

    function testInitialInventoryOnlyMovesToConfiguredLauncherUntilRelease() public {
        MockPipedogHybrid quote = new MockPipedogHybrid();
        RewardPoolManagerMock freshManager = new RewardPoolManagerMock();
        LayPipeHybridToken fresh =
            new LayPipeHybridToken(address(this), quote, IPoolManager(address(freshManager)), address(this), "");
        PipeDogRewards freshVault = fresh.rewardVault();
        RewardNotifierMock freshHook = new RewardNotifierMock(freshVault, freshManager);
        SystemHolder freshLauncher = new SystemHolder();
        BindingRouterMock freshRouter = new BindingRouterMock();

        vm.expectRevert(abi.encodeWithSelector(LayPipeHybridToken.InitialInventoryLocked.selector, alice));
        fresh.transfer(alice, 1);

        _bindSystem(fresh, freshVault, freshManager, freshHook, freshLauncher, freshRouter);
        freshVault.setRewardNotifier(address(freshHook));
        fresh.configureSystemExclusions(
            address(freshLauncher), address(freshHook), address(freshManager), address(freshRouter)
        );

        vm.expectRevert(abi.encodeWithSelector(LayPipeHybridToken.InitialInventoryLocked.selector, alice));
        fresh.transfer(alice, 1);

        vm.expectRevert(
            abi.encodeWithSelector(LayPipeHybridToken.InitialInventoryLocked.selector, address(freshLauncher))
        );
        fresh.transfer(address(freshLauncher), 1);

        fresh.approve(address(freshLauncher), fresh.INITIAL_SUPPLY());
        freshLauncher.pull(IERC20(address(fresh)), address(this), fresh.INITIAL_SUPPLY());
        assertEq(fresh.balanceOf(address(freshLauncher)), fresh.INITIAL_SUPPLY());
        fresh.releaseInitialSupplyOwner();

        freshLauncher.send(IERC20(address(fresh)), address(this), 1);
        assertTrue(fresh.transfer(alice, 1));
    }

    function testCannotReleaseFundedInitialSupplyOwner() public {
        MockPipedogHybrid quote = new MockPipedogHybrid();
        RewardPoolManagerMock freshManager = new RewardPoolManagerMock();
        LayPipeHybridToken fresh =
            new LayPipeHybridToken(address(this), quote, IPoolManager(address(freshManager)), address(this), "");
        PipeDogRewards freshVault = fresh.rewardVault();
        RewardNotifierMock freshNotifier = new RewardNotifierMock(freshVault, freshManager);
        SystemHolder freshLauncher = new SystemHolder();
        BindingRouterMock freshRouter = new BindingRouterMock();
        _bindSystem(fresh, freshVault, freshManager, freshNotifier, freshLauncher, freshRouter);
        freshVault.setRewardNotifier(address(freshNotifier));
        fresh.configureSystemExclusions(
            address(freshLauncher), address(freshNotifier), address(freshManager), address(freshRouter)
        );

        vm.expectRevert(
            abi.encodeWithSelector(LayPipeHybridToken.InitialSupplyOwnerHasWholeUnit.selector, fresh.INITIAL_SUPPLY())
        );
        fresh.releaseInitialSupplyOwner();
    }

    function testSubUnitLaunchDustCanBeReleasedAndAllTenThousandNFTsRemainReachable() public {
        MockPipedogHybrid quote = new MockPipedogHybrid();
        RewardPoolManagerMock freshManager = new RewardPoolManagerMock();
        LayPipeHybridToken fresh =
            new LayPipeHybridToken(address(this), quote, IPoolManager(address(freshManager)), address(this), "");
        PipeDogRewards freshVault = fresh.rewardVault();
        DN404Mirror freshMirror = DN404Mirror(payable(fresh.mirrorERC721()));
        RewardNotifierMock freshHook = new RewardNotifierMock(freshVault, freshManager);
        SystemHolder freshLauncher = new SystemHolder();
        BindingRouterMock freshRouter = new BindingRouterMock();
        _bindSystem(fresh, freshVault, freshManager, freshHook, freshLauncher, freshRouter);
        freshVault.setRewardNotifier(address(freshHook));

        fresh.configureSystemExclusions(
            address(freshLauncher), address(freshHook), address(freshManager), address(freshRouter)
        );

        uint256 dust = 12_264;
        fresh.approve(address(freshLauncher), fresh.INITIAL_SUPPLY());
        freshLauncher.pull(IERC20(address(fresh)), address(this), fresh.INITIAL_SUPPLY());
        freshLauncher.send(IERC20(address(fresh)), address(this), dust);
        fresh.releaseInitialSupplyOwner();

        assertEq(fresh.balanceOf(address(this)), dust);
        assertFalse(fresh.isExcluded(address(this)));
        assertFalse(fresh.getSkipNFT(address(this)));
        assertEq(freshMirror.balanceOf(address(this)), 0);
        assertEq(freshVault.eligibleUnitsOf(address(this)), 0);

        // Split within the 20-NFT automatic-sync cap. The excluded launch
        // inventory first materializes 9,999 NFTs; consolidating its returned
        // rounding dust crosses the final threshold and reaches the full cap.
        for (uint256 i; i < 499; ++i) {
            freshLauncher.send(IERC20(address(fresh)), alice, 20 * UNIT);
        }
        freshLauncher.send(IERC20(address(fresh)), alice, 20 * UNIT - dust);
        assertEq(freshMirror.balanceOf(alice), 9_999);

        fresh.transfer(alice, dust);
        assertEq(fresh.balanceOf(alice), fresh.INITIAL_SUPPLY());
        assertEq(freshMirror.balanceOf(alice), 10_000);
        assertEq(freshMirror.totalSupply(), fresh.MAX_NFT_SUPPLY());
        assertEq(freshVault.eligibleUnitsOf(alice), 10_000);
    }

    function testAutomaticNFTDeltaIsCappedAndCanBeSplit() public {
        vm.expectRevert(abi.encodeWithSelector(LayPipeHybridToken.AutomaticNFTDeltaTooLarge.selector, 21, 20));
        launcher.send(IERC20(address(token)), alice, 21 * UNIT);

        launcher.send(IERC20(address(token)), alice, 20 * UNIT);
        launcher.send(IERC20(address(token)), alice, UNIT);
        assertEq(mirror.balanceOf(alice), 21);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LayPipeHybridToken.AutomaticNFTDeltaTooLarge.selector, 21, 20));
        token.transfer(address(manager), 21 * UNIT);

        vm.prank(alice);
        token.transfer(address(manager), 20 * UNIT);
        vm.prank(alice);
        token.transfer(address(manager), UNIT);
        assertEq(mirror.balanceOf(alice), 0);
    }

    function testLargeSelfTransferDoesNotHitAutomaticCap() public {
        launcher.send(IERC20(address(token)), alice, 20 * UNIT);
        launcher.send(IERC20(address(token)), alice, UNIT);
        vm.prank(alice);
        token.transfer(alice, 21 * UNIT);
        assertEq(mirror.balanceOf(alice), 21);
        assertEq(vault.eligibleUnitsOf(alice), 21);
    }

    function testHolderCannotDisableAutomaticNFTs() public {
        vm.prank(alice);
        vm.expectRevert(LayPipeHybridToken.AutomaticNFTsRequired.selector);
        token.setSkipNFT(true);

        vm.prank(address(launcher));
        vm.expectRevert(LayPipeHybridToken.ExcludedAddress.selector);
        token.setSkipNFT(false);
    }

    function testNFTCannotTransferIntoExcludedSystemAddress() public {
        launcher.send(IERC20(address(token)), alice, UNIT);
        vm.prank(alice);
        vm.expectRevert(LayPipeHybridToken.ExcludedAddress.selector);
        mirror.transferFrom(alice, address(manager), 1);
    }

    function testDirectPipedogDonationCannotBlockNotificationOrBecomeReward() public {
        pipedog.mint(address(this), 7 ether);
        pipedog.transfer(address(vault), 7 ether);
        notifier.notify(100 ether);
        launcher.send(IERC20(address(token)), alice, UNIT);

        assertEq(vault.claimable(alice), 100 ether);
        vm.prank(alice);
        vault.claim();
        assertEq(pipedog.balanceOf(address(vault)), 7 ether);
    }

    function testNotificationRequiresAuthorizedNotifierAndPrefunding() public {
        vm.prank(alice);
        vm.expectRevert(PipeDogRewards.NotRewardNotifier.selector);
        vault.notifyRewardClaim(1 ether);

        vm.expectRevert(abi.encodeWithSelector(PipeDogRewards.RewardClaimMismatch.selector, 1 ether, 0));
        notifier.notifyWithoutFunding(1 ether);
    }

    function testClaimBalanceMismatchCannotDoubleCountOldClaims() public {
        launcher.send(IERC20(address(token)), alice, UNIT);
        notifier.notify(10 ether);

        vm.expectRevert(abi.encodeWithSelector(PipeDogRewards.RewardClaimMismatch.selector, 11 ether, 10 ether));
        notifier.notifyWithoutFunding(1 ether);
    }

    function testManyTinyRewardsClaimsThenAnotherNotification() public {
        launcher.send(IERC20(address(token)), alice, UNIT);
        launcher.send(IERC20(address(token)), bob, 2 * UNIT);

        for (uint256 i; i < 64; ++i) {
            notifier.notify(1);
            if (i % 3 == 0) {
                vm.prank(alice);
                vault.claim();
                vm.prank(bob);
                vault.claim();
            }
        }

        // Rounding dust remains backed by ERC6909 claims and cannot make the
        // next trade-time notification fail its liability coverage check.
        notifier.notify(1 ether);
        assertEq(vault.totalRewardsNotified(), 1 ether + 64);
        assertEq(
            manager.claimBalance(address(vault), vault.pipedogClaimId()),
            vault.totalRewardsNotified() - vault.totalRewardsClaimed()
        );
    }

    function testNotifierAndSystemConfigurationAreOneTimeAndCodeOnly() public {
        MockPipedogHybrid quote = new MockPipedogHybrid();
        RewardPoolManagerMock freshManager = new RewardPoolManagerMock();
        LayPipeHybridToken fresh =
            new LayPipeHybridToken(address(this), quote, IPoolManager(address(freshManager)), address(this), "");
        PipeDogRewards freshVault = fresh.rewardVault();

        vm.expectRevert(PipeDogRewards.ZeroAddress.selector);
        freshVault.setRewardNotifier(alice);

        RewardNotifierMock freshNotifier = new RewardNotifierMock(freshVault, freshManager);
        SystemHolder freshLauncher = new SystemHolder();
        BindingRouterMock freshRouter = new BindingRouterMock();
        _bindSystem(fresh, freshVault, freshManager, freshNotifier, freshLauncher, freshRouter);
        freshVault.setRewardNotifier(address(freshNotifier));
        vm.expectRevert(PipeDogRewards.AlreadyConfigured.selector);
        freshVault.setRewardNotifier(address(freshNotifier));

        fresh.configureSystemExclusions(
            address(freshLauncher), address(freshNotifier), address(freshManager), address(freshRouter)
        );
        SystemHolder duplicateLauncher = new SystemHolder();
        CodeOnly duplicateManager = new CodeOnly();
        CodeOnly duplicateRouter = new CodeOnly();
        vm.expectRevert(LayPipeHybridToken.AlreadyConfigured.selector);
        fresh.configureSystemExclusions(
            address(duplicateLauncher), address(freshNotifier), address(duplicateManager), address(duplicateRouter)
        );
    }

    function testSystemAddressMustBeUnfundedBeforeExclusion() public {
        MockPipedogHybrid quote = new MockPipedogHybrid();
        RewardPoolManagerMock freshManager = new RewardPoolManagerMock();
        LayPipeHybridTokenHarness fresh =
            new LayPipeHybridTokenHarness(address(this), quote, IPoolManager(address(freshManager)), address(this));
        PipeDogRewards freshVault = fresh.rewardVault();
        RewardNotifierMock freshNotifier = new RewardNotifierMock(freshVault, freshManager);
        SystemHolder fundedLauncher = new SystemHolder();
        BindingRouterMock freshRouter = new BindingRouterMock();
        _bindSystem(fresh, freshVault, freshManager, freshNotifier, fundedLauncher, freshRouter);
        freshVault.setRewardNotifier(address(freshNotifier));

        fresh.forceMintForConfigTest(alice, UNIT);
        vm.prank(alice);
        fresh.transfer(address(fundedLauncher), UNIT);
        assertEq(DN404Mirror(payable(fresh.mirrorERC721())).balanceOf(address(fundedLauncher)), 1);
        assertEq(freshVault.eligibleUnitsOf(address(fundedLauncher)), 1);

        vm.expectRevert(
            abi.encodeWithSelector(LayPipeHybridToken.SystemAddressAlreadyFunded.selector, address(fundedLauncher))
        );
        fresh.configureSystemExclusions(
            address(fundedLauncher), address(freshNotifier), address(freshManager), address(freshRouter)
        );

        assertFalse(fresh.systemExclusionsConfigured());
        assertFalse(fresh.isExcluded(address(fundedLauncher)));
        assertEq(freshVault.eligibleUnitsOf(address(fundedLauncher)), 1);
    }

    function testSystemBindingRejectsAValidButWrongRouterAddress() public {
        MockPipedogHybrid quote = new MockPipedogHybrid();
        RewardPoolManagerMock freshManager = new RewardPoolManagerMock();
        LayPipeHybridToken fresh =
            new LayPipeHybridToken(address(this), quote, IPoolManager(address(freshManager)), address(this), "");
        PipeDogRewards freshVault = fresh.rewardVault();
        RewardNotifierMock freshHook = new RewardNotifierMock(freshVault, freshManager);
        SystemHolder freshLauncher = new SystemHolder();
        BindingRouterMock canonicalRouter = new BindingRouterMock();
        BindingRouterMock typoRouter = new BindingRouterMock();
        _bindSystem(fresh, freshVault, freshManager, freshHook, freshLauncher, canonicalRouter);
        bytes32 id = canonicalRouter.poolId();
        typoRouter.bind(
            address(freshManager), address(quote), address(fresh), address(freshHook), address(freshLauncher), id
        );
        freshVault.setRewardNotifier(address(freshHook));

        vm.expectRevert(abi.encodeWithSelector(LayPipeHybridToken.InvalidSystemBinding.selector, address(freshHook)));
        fresh.configureSystemExclusions(
            address(freshLauncher), address(freshHook), address(freshManager), address(typoRouter)
        );

        assertFalse(fresh.systemExclusionsConfigured());
        assertFalse(fresh.isExcluded(address(freshLauncher)));
        assertFalse(fresh.isExcluded(address(freshHook)));
        assertFalse(fresh.isExcluded(address(freshManager)));
        assertFalse(fresh.isExcluded(address(typoRouter)));
    }

    function testPermit2DoesNotReceiveImplicitInfiniteAllowance() public view {
        address permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        assertEq(token.allowance(alice, permit2), 0);
    }

    function testInsufficientBalanceKeepsDN404Error() public {
        vm.prank(alice);
        vm.expectRevert(DN404.InsufficientBalance.selector);
        token.transfer(bob, 1);
    }
}
