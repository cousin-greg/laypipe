// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {DN404} from "dn404/DN404.sol";
import {PipeDogRewards} from "./PipeDogRewards.sol";
import {PipeDogsMirror} from "./PipeDogsMirror.sol";

/// @title LayPipeHybridToken
/// @notice Fixed-supply ERC-7631 pair: fungible LAYPIPE and automatic PipeDog NFTs.
contract LayPipeHybridToken is DN404 {
    error NotConfigurator();
    error AlreadyConfigured();
    error InvalidSystemAddress();
    error SystemAddressAlreadyFunded(address account);
    error InvalidSystemBinding(address component);
    error InitialInventoryLocked(address recipient);
    error ExcludedAddress();
    error AutomaticNFTsRequired();
    error AutomaticNFTDeltaTooLarge(uint256 requested, uint256 maximum);
    error InitialSupplyOwnerHasWholeUnit(uint256 balance);

    event SystemExclusionsConfigured(
        address indexed launcher, address indexed hook, address indexed poolManager, address router
    );
    event InitialSupplyOwnerReleased(address indexed account);

    uint256 public constant NFT_UNIT = 100_000 ether;
    uint256 public constant MAX_NFT_SUPPLY = 10_000;
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MAX_AUTOMATIC_NFT_DELTA = 20;

    bytes4 private constant _POOL_MANAGER_SELECTOR = bytes4(keccak256("poolManager()"));
    bytes4 private constant _PIPEDOG_SELECTOR = bytes4(keccak256("pipedog()"));
    bytes4 private constant _TOKEN_SELECTOR = bytes4(keccak256("laypipeToken()"));
    bytes4 private constant _HOOK_SELECTOR = bytes4(keccak256("hook()"));
    bytes4 private constant _VAULT_SELECTOR = bytes4(keccak256("rewardVault()"));
    bytes4 private constant _CONFIGURATOR_SELECTOR = bytes4(keccak256("configurator()"));
    bytes4 private constant _LAUNCHER_SELECTOR = bytes4(keccak256("launcher()"));
    bytes4 private constant _ROUTER_SELECTOR = bytes4(keccak256("canonicalRouter()"));
    bytes4 private constant _POOL_ID_SELECTOR = bytes4(keccak256("poolId()"));
    bytes4 private constant _CONFIGURED_POOL_ID_SELECTOR = bytes4(keccak256("configuredPoolId()"));

    address public immutable configurator;
    address public immutable initialSupplyOwner;
    PipeDogRewards public immutable rewardVault;
    address public systemLauncher;

    string private _baseURI;
    mapping(address => bool) public isExcluded;
    bool public systemExclusionsConfigured;
    bool public initialSupplyOwnerReleased;

    constructor(
        address initialSupplyOwner_,
        IERC20 pipedog,
        IPoolManager poolManager,
        address configurator_,
        string memory baseURI_
    ) {
        if (initialSupplyOwner_ == address(0) || configurator_ == address(0)) {
            revert InvalidSystemAddress();
        }
        configurator = configurator_;
        initialSupplyOwner = initialSupplyOwner_;
        _baseURI = baseURI_;

        // DN404 reads this flag during initialization. Install it first so the
        // one-billion-token deployment allocation never attempts 10,000 NFT mints.
        _exclude(initialSupplyOwner_);
        PipeDogsMirror mirror = new PipeDogsMirror(msg.sender);
        _initializeDN404(INITIAL_SUPPLY, initialSupplyOwner_, address(mirror));

        PipeDogRewards vault = new PipeDogRewards(pipedog, poolManager, configurator_);
        rewardVault = vault;

        _exclude(address(this));
        _exclude(address(mirror));
        _exclude(address(vault));
    }

    function name() public pure override returns (string memory) {
        return "LayPipe";
    }

    function symbol() public pure override returns (string memory) {
        return "LAYPIPE";
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @notice One-time deployment wiring for every system address that can hold LAYPIPE.
    /// @dev Configure before moving supply; all four permanently skip NFTs and rewards.
    function configureSystemExclusions(address launcher, address hook, address poolManager, address router) external {
        if (msg.sender != configurator) revert NotConfigurator();
        if (systemExclusionsConfigured) revert AlreadyConfigured();
        if (
            launcher.code.length == 0 || hook.code.length == 0 || poolManager.code.length == 0
                || router.code.length == 0 || launcher == hook || launcher == poolManager || launcher == router
                || hook == poolManager || hook == router || poolManager == router || isExcluded[launcher]
                || isExcluded[hook] || isExcluded[poolManager] || isExcluded[router]
        ) {
            revert InvalidSystemAddress();
        }
        _requireUnfundedSystemAddress(launcher);
        _requireUnfundedSystemAddress(hook);
        _requireUnfundedSystemAddress(poolManager);
        _requireUnfundedSystemAddress(router);
        _validateSystemBindings(launcher, hook, poolManager, router);
        systemLauncher = launcher;
        systemExclusionsConfigured = true;
        _exclude(launcher);
        _exclude(hook);
        _exclude(poolManager);
        _exclude(router);
        emit SystemExclusionsConfigured(launcher, hook, poolManager, router);
    }

    /// @notice Makes the deployment wallet an ordinary automatic holder after
    /// its whole-unit launch inventory has moved into the excluded launcher.
    /// Sub-unit liquidity rounding dust is safe because it represents no NFT
    /// or reward unit and becomes ordinary transferable LAYPIPE after release.
    function releaseInitialSupplyOwner() external {
        if (msg.sender != configurator) revert NotConfigurator();
        if (!systemExclusionsConfigured || initialSupplyOwnerReleased) revert AlreadyConfigured();
        address account = initialSupplyOwner;
        uint256 balance = balanceOf(account);
        if (balance >= NFT_UNIT) revert InitialSupplyOwnerHasWholeUnit(balance);
        initialSupplyOwnerReleased = true;
        isExcluded[account] = false;
        _setSkipNFT(account, false);
        rewardVault.sync(account, 0);
        emit InitialSupplyOwnerReleased(account);
    }

    /// @notice Automatic NFTs cannot be disabled by ordinary holders.
    function setSkipNFT(bool skipNFT) public override returns (bool) {
        if (isExcluded[msg.sender]) {
            if (!skipNFT) revert ExcludedAddress();
            return super.setSkipNFT(true);
        }
        if (skipNFT) revert AutomaticNFTsRequired();
        return super.setSkipNFT(false);
    }

    /// @notice Whole reward units represented by `account`'s current balance.
    function eligibleUnits(address account) public view returns (uint256) {
        return isExcluded[account] ? 0 : balanceOf(account) / NFT_UNIT;
    }

    function maxTransferForAutomaticNFTs() external pure returns (uint256) {
        return MAX_AUTOMATIC_NFT_DELTA * NFT_UNIT;
    }

    function _unit() internal pure override returns (uint256) {
        return NFT_UNIT;
    }

    function _tokenURI(uint256 tokenId) internal view override returns (string memory) {
        return string(abi.encodePacked(_baseURI, _toString(tokenId)));
    }

    function _skipNFTDefault(address owner) internal view override returns (bool) {
        return isExcluded[owner];
    }

    // LayPipe requires exact, explicit ERC20 approvals. DN404's optional Permit2
    // implicit infinite allowance is disabled for the same reason.
    function _givePermit2DefaultInfiniteAllowance() internal pure override returns (bool) {
        return false;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (from == initialSupplyOwner && !initialSupplyOwnerReleased) {
            if (!systemExclusionsConfigured || to != systemLauncher || msg.sender != systemLauncher) {
                revert InitialInventoryLocked(to);
            }
        }
        _checkAutomaticNFTDelta(from, to, amount);
        _syncReward(from);
        if (to != from) _syncReward(to);
        super._transfer(from, to, amount);
        _syncReward(from);
        if (to != from) _syncReward(to);
    }

    function _transferFromNFT(address from, address to, uint256 id, address msgSender) internal override {
        if (isExcluded[to]) revert ExcludedAddress();
        _syncReward(from);
        if (to != from) _syncReward(to);
        super._transferFromNFT(from, to, id, msgSender);
        _syncReward(from);
        if (to != from) _syncReward(to);
    }

    function _checkAutomaticNFTDelta(address from, address to, uint256 amount) private view {
        if (from == to) return;
        uint256 fromBalance = balanceOf(from);
        // Preserve DN404's canonical InsufficientBalance error from `super`.
        if (amount > fromBalance) return;
        uint256 fromBefore = fromBalance / NFT_UNIT;
        uint256 toBefore = balanceOf(to) / NFT_UNIT;
        uint256 fromAfter = (fromBalance - amount) / NFT_UNIT;
        uint256 toAfter = (balanceOf(to) + amount) / NFT_UNIT;
        uint256 burns = isExcluded[from] ? 0 : fromBefore - fromAfter;
        uint256 mints = isExcluded[to] ? 0 : toAfter - toBefore;
        uint256 delta = burns > mints ? burns : mints;
        if (delta > MAX_AUTOMATIC_NFT_DELTA) {
            revert AutomaticNFTDeltaTooLarge(delta, MAX_AUTOMATIC_NFT_DELTA);
        }
    }

    function _syncReward(address account) private {
        rewardVault.sync(account, eligibleUnits(account));
    }

    function _exclude(address account) private {
        isExcluded[account] = true;
        _setSkipNFT(account, true);
    }

    function _requireUnfundedSystemAddress(address account) private view {
        if (
            balanceOf(account) != 0 || IERC721(mirrorERC721()).balanceOf(account) != 0
                || rewardVault.eligibleUnitsOf(account) != 0
        ) {
            revert SystemAddressAlreadyFunded(account);
        }
    }

    function _validateSystemBindings(address launcher, address hook, address poolManager, address router) private view {
        address vault = address(rewardVault);
        address pipedog = address(rewardVault.pipedog());
        if (
            address(rewardVault.poolManager()) != poolManager || rewardVault.token() != address(this)
                || rewardVault.configurator() != configurator || rewardVault.rewardNotifier() != hook
        ) {
            revert InvalidSystemBinding(vault);
        }

        if (
            _readAddress(hook, _POOL_MANAGER_SELECTOR) != poolManager
                || _readAddress(hook, _PIPEDOG_SELECTOR) != pipedog || _readAddress(hook, _VAULT_SELECTOR) != vault
                || _readAddress(hook, _CONFIGURATOR_SELECTOR) != configurator
                || _readAddress(hook, _LAUNCHER_SELECTOR) != launcher || _readAddress(hook, _ROUTER_SELECTOR) != router
        ) {
            revert InvalidSystemBinding(hook);
        }

        if (
            _readAddress(launcher, _POOL_MANAGER_SELECTOR) != poolManager
                || _readAddress(launcher, _PIPEDOG_SELECTOR) != pipedog
                || _readAddress(launcher, _TOKEN_SELECTOR) != address(this)
                || _readAddress(launcher, _HOOK_SELECTOR) != hook
        ) {
            revert InvalidSystemBinding(launcher);
        }

        if (
            _readAddress(router, _POOL_MANAGER_SELECTOR) != poolManager
                || _readAddress(router, _PIPEDOG_SELECTOR) != pipedog
                || _readAddress(router, _TOKEN_SELECTOR) != address(this)
                || _readAddress(router, _HOOK_SELECTOR) != hook || _readAddress(router, _LAUNCHER_SELECTOR) != launcher
                || _readBytes32(router, _POOL_ID_SELECTOR) != _readBytes32(launcher, _CONFIGURED_POOL_ID_SELECTOR)
        ) {
            revert InvalidSystemBinding(router);
        }
    }

    function _readAddress(address component, bytes4 selector) private view returns (address result) {
        (bool ok, bytes memory data) = component.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length != 32) revert InvalidSystemBinding(component);
        result = abi.decode(data, (address));
    }

    function _readBytes32(address component, bytes4 selector) private view returns (bytes32 result) {
        (bool ok, bytes memory data) = component.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length != 32) revert InvalidSystemBinding(component);
        result = abi.decode(data, (bytes32));
    }

    function _toString(uint256 value) private pure returns (string memory str) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            ++digits;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            buffer[--digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
