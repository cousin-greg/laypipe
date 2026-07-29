// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CurrencySettler} from "./lib/CurrencySettler.sol";
import {PipedogHook} from "./PipedogHook.sol";
import {LaypipeToken} from "./LaypipeToken.sol";

/// @title LaypipeSelfBurner
/// @notice Fee recipient for self-burn launches: the creator share of every
///         fee market-buys the launched token on its own pool and destroys it
///         — a real burn that reduces totalSupply on-chain, not a dead-address
///         park. Anyone can pull the trigger; nobody — creator, platform, or
///         owner — can redirect the flow. The contract has no owner and no
///         withdrawal path by construction.
/// @dev The burn buy trades through the pool like any other swap, so it pays
///      the pool's fee too — a slice of every burn feeds the next one and the
///      platform's PIPEDOG burn. Burns carry no slippage guard on purpose
///      (moving the price up is the point), so exposure is bounded two ways
///      instead: each call burns at most MAX_BURN_PER_CALL of fuel, and each
///      pool burns at most once per block — a backlog of accrued fees drains
///      over blocks rather than becoming one sandwich-sized clip.
contract LaypipeSelfBurner is IUnlockCallback {
    using CurrencySettler for Currency;

    error NotFactory();
    error NotPoolManager();
    error UnknownPool();
    error AlreadyRegistered();
    error NothingToBurn();
    error BountyPayFailed();
    error BurnedThisBlock();

    event Burned(PoolId indexed poolId, address indexed token, uint256 ethIn, uint256 tokensBurned, uint256 bounty);

    /// @notice Most fuel a single burn call may spend. Caps how much a
    ///         sandwich around one burn can ever be worth; backlogs drain over
    ///         multiple blocks instead.
    uint256 public constant MAX_BURN_PER_CALL = 0.1 ether;
    /// @notice Share of each claim paid to whoever triggers the burn, in bps.
    ///         The bounty is what makes burns self-driving: the moment a pool's
    ///         accrued fees cover gas plus profit, keeper bots race to fire it —
    ///         no operator, no cron, no trust. Anyone (including our own UI
    ///         visitors) can collect it.
    uint256 public constant BOUNTY_BPS = 100; // 1% of the claim

    IPoolManager public immutable poolManager;
    PipedogHook public immutable hook;
    address public immutable factory;

    mapping(PoolId => PoolKey) private _keys;
    /// @notice Claimed fuel waiting to burn, per pool (a claim larger than the
    ///         per-call cap drains across successive blocks).
    mapping(PoolId => uint256) public unburned;
    /// @dev Keyed on block.number, which on an Orbit chain tracks the parent
    ///      chain's block number — so "once per block" is coarser (stricter)
    ///      than one L2 block. That only slows drain cadence, never loosens it.
    mapping(PoolId => uint256) private _lastBurnBlock;

    constructor(IPoolManager poolManager_, PipedogHook hook_, address factory_) {
        poolManager = poolManager_;
        hook = hook_;
        factory = factory_;
    }

    /// @notice The factory wires each self-burn pool in at launch.
    function register(PoolId poolId, PoolKey calldata key) external {
        if (msg.sender != factory) revert NotFactory();
        if (Currency.unwrap(_keys[poolId].currency1) != address(0)) revert AlreadyRegistered();
        _keys[poolId] = key;
    }

    /// @notice Claims the pool's accrued creator share from the hook and
    ///         buys + burns the token with it. Callable by anyone; pays the
    ///         caller the bounty. At most MAX_BURN_PER_CALL of fuel per call
    ///         and one call per pool per block — larger backlogs drain across
    ///         blocks, keeping any single burn too small to be worth
    ///         sandwiching hard.
    function burn(PoolId poolId) external returns (uint256 tokensBurned) {
        PoolKey memory key = _keys[poolId];
        if (Currency.unwrap(key.currency1) == address(0)) revert UnknownPool();
        if (_lastBurnBlock[poolId] == block.number) revert BurnedThisBlock();
        _lastBurnBlock[poolId] = block.number;

        // pull everything claimable into the per-pool fuel tank, then spend
        // at most the per-call cap
        if (hook.pending(poolId) > 0 || hook.tab(poolId) > 0) {
            unburned[poolId] += hook.claim(poolId); // paid in native ETH
        }
        uint256 fuel = unburned[poolId];
        if (fuel == 0) revert NothingToBurn();
        uint256 ethIn = fuel > MAX_BURN_PER_CALL ? MAX_BURN_PER_CALL : fuel;
        unburned[poolId] = fuel - ethIn;

        uint256 bounty = (ethIn * BOUNTY_BPS) / 10_000;
        uint256 burnEth = ethIn - bounty;
        (uint256 tokensOut, uint256 ethSpent) =
            abi.decode(poolManager.unlock(abi.encode(key, burnEth)), (uint256, uint256));
        // an exact-input swap can stop at its price limit with input left
        // over — return any unspent fuel to the tank so the burner's ETH
        // balance and its accounting can never diverge. (The hook now rejects
        // price-limited partial fills outright, so this branch is
        // defense-in-depth rather than a live path.)
        if (ethSpent < burnEth) {
            unburned[poolId] += burnEth - ethSpent;
        }
        // no bounty for burning nothing: reverting here also rolls back the
        // fuel deduction, so a pool sitting at its price floor can't be
        // milked for bounties
        if (tokensOut == 0) revert NothingToBurn();
        tokensBurned = tokensOut;
        if (bounty > 0) {
            (bool paid,) = msg.sender.call{value: bounty}("");
            if (!paid) revert BountyPayFailed();
        }
        emit Burned(poolId, Currency.unwrap(key.currency1), ethSpent, tokensBurned, bounty);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 ethIn) = abi.decode(data, (PoolKey, uint256));

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        uint256 tokensOut = uint256(uint128(delta.amount1()));
        uint256 ethSpent = uint256(uint128(-delta.amount0()));
        key.currency0.settle(poolManager, address(this), ethSpent, false);
        // take the tokens here, then destroy them for real — totalSupply drops
        key.currency1.take(poolManager, address(this), tokensOut, false);
        LaypipeToken(Currency.unwrap(key.currency1)).burn(tokensOut);
        return abi.encode(tokensOut, ethSpent);
    }

    /// @notice The pool key a self-burn pool trades through.
    function poolKeyOf(PoolId poolId) external view returns (PoolKey memory) {
        return _keys[poolId];
    }

    receive() external payable {} // the hook pays claims in native ETH
}
