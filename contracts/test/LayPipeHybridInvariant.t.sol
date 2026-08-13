// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {LayPipeHybridToken} from "../src/LayPipeHybridToken.sol";
import {PipeDogRewards} from "../src/PipeDogRewards.sol";

contract InvariantPipedog is ERC20 {
    constructor() ERC20("PipeDog", "PIPEDOG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract InvariantSystemHolder {
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

contract InvariantBindingRouter {
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

contract InvariantPoolManagerMock {
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
}

contract LayPipeHybridHandler is Test {
    uint256 private constant UNIT = 100_000 ether;

    InvariantPipedog public immutable pipedog;
    LayPipeHybridToken public immutable token;
    PipeDogRewards public immutable vault;
    InvariantSystemHolder public immutable launcher;
    InvariantPoolManagerMock public immutable manager;

    address[] private _actors;
    uint256 public notified;
    uint256 public notifications;
    address public canonicalRouter;

    constructor(
        InvariantPipedog pipedog_,
        LayPipeHybridToken token_,
        PipeDogRewards vault_,
        InvariantSystemHolder launcher_,
        InvariantPoolManagerMock manager_,
        address[] memory actors_
    ) {
        pipedog = pipedog_;
        token = token_;
        vault = vault_;
        launcher = launcher_;
        manager = manager_;
        _actors = actors_;
    }

    function bindRouter(address router_) external {
        canonicalRouter = router_;
    }

    function poolManager() external view returns (address) {
        return address(manager);
    }

    function laypipeToken() external view returns (address) {
        return address(token);
    }

    function rewardVault() external view returns (address) {
        return address(vault);
    }

    function configurator() external view returns (address) {
        return vault.configurator();
    }

    function distribute(uint256 actorSeed, uint256 rawAmount) external {
        address actor = _actors[actorSeed % _actors.length];
        uint256 available = token.balanceOf(address(launcher));
        if (available == 0) return;
        uint256 amount = bound(rawAmount, 1, _min(available, 20 * UNIT));
        launcher.send(IERC20(address(token)), actor, amount);
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 rawAmount) external {
        address from = _actors[fromSeed % _actors.length];
        address to = _actors[toSeed % _actors.length];
        uint256 available = token.balanceOf(from);
        if (available == 0 || from == to) return;
        uint256 amount = bound(rawAmount, 1, _min(available, 20 * UNIT));
        vm.prank(from);
        token.transfer(to, amount);
    }

    function notify(uint256 rawAmount) external {
        uint256 amount = bound(rawAmount, 1, 1_000_000 ether);
        pipedog.mint(address(manager), amount);
        manager.mint(address(vault), vault.pipedogClaimId(), amount);
        notified += amount;
        notifications += 1;
        vault.notifyRewardClaim(amount);
    }

    function claim(uint256 actorSeed) external {
        address actor = _actors[actorSeed % _actors.length];
        if (vault.claimable(actor) == 0) return;
        vm.prank(actor);
        vault.claim();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract LayPipeHybridInvariant is StdInvariant, Test {
    uint256 private constant UNIT = 100_000 ether;

    InvariantPipedog private pipedog;
    LayPipeHybridToken private token;
    PipeDogRewards private vault;
    DN404Mirror private mirror;
    InvariantSystemHolder private launcher;
    InvariantPoolManagerMock private manager;
    LayPipeHybridHandler private handler;
    address[] private actors;

    function setUp() public {
        pipedog = new InvariantPipedog();
        manager = new InvariantPoolManagerMock();
        token = new LayPipeHybridToken(
            address(this), pipedog, IPoolManager(address(manager)), address(this), "ipfs://pipedogs/"
        );
        vault = token.rewardVault();
        mirror = DN404Mirror(payable(token.mirrorERC721()));
        launcher = new InvariantSystemHolder();

        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
        actors.push(makeAddr("dave"));

        handler = new LayPipeHybridHandler(pipedog, token, vault, launcher, manager, actors);
        InvariantBindingRouter router = new InvariantBindingRouter();
        bytes32 id = keccak256(abi.encode(address(token), address(vault)));
        launcher.bind(address(manager), address(pipedog), address(token), address(handler), id);
        router.bind(address(manager), address(pipedog), address(token), address(handler), address(launcher), id);
        handler.bindRouter(address(router));
        vault.setRewardNotifier(address(handler));
        token.configureSystemExclusions(address(launcher), address(handler), address(manager), address(router));
        token.approve(address(launcher), token.totalSupply());
        launcher.pull(IERC20(address(token)), address(this), token.totalSupply());
        token.releaseInitialSupplyOwner();
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.distribute.selector;
        selectors[1] = handler.transfer.selector;
        selectors[2] = handler.notify.selector;
        selectors[3] = handler.claim.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantFixedFungibleSupplyAndNftCap() public view {
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertLe(mirror.totalSupply(), 10_000);
    }

    function invariantMirrorAndRewardUnitsMatchWholeBalances() public view {
        uint256 totalUnits;
        for (uint256 i; i < actors.length; ++i) {
            address actor = actors[i];
            uint256 units = token.balanceOf(actor) / UNIT;
            assertEq(mirror.balanceOf(actor), units);
            assertEq(vault.eligibleUnitsOf(actor), units);
            totalUnits += units;
        }
        assertEq(vault.totalEligibleUnits(), totalUnits);
    }

    function invariantExcludedInventoryNeverMaterializesOrEarns() public view {
        assertEq(mirror.balanceOf(address(launcher)), 0);
        assertEq(vault.eligibleUnitsOf(address(launcher)), 0);
        assertEq(vault.claimable(address(launcher)), 0);
    }

    function invariantRewardSolvencyAndConservation() public view {
        assertEq(vault.totalRewardsNotified(), handler.notified());
        assertEq(
            manager.claimBalance(address(vault), vault.pipedogClaimId()),
            vault.totalRewardsNotified() - vault.totalRewardsClaimed()
        );
        uint256 aggregateClaimable;
        for (uint256 i; i < actors.length; ++i) {
            aggregateClaimable += vault.claimable(actors[i]);
        }
        assertLe(
            aggregateClaimable + vault.totalRewardsClaimed() + vault.undistributedRewards(),
            // Each accumulator update can leave sub-wei precision dust. Bound
            // the assertion by one wei per funded update and tracked actor.
            vault.totalRewardsNotified() + handler.notifications() * actors.length
        );
    }
}
