// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IUniswapV3SwapCallback} from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FeeOnTransferERC20 is MockERC20 {
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    uint16 public immutable feeBps;
    address public immutable feeRecipient;

    constructor(uint16 feeBps_) MockERC20("Fee Pipedog", "FEE-PIPEDOG") {
        require(feeBps_ <= BPS_DENOMINATOR, "fee too high");
        feeBps = feeBps_;
        feeRecipient = address(0xFEE);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / BPS_DENOMINATOR;
        super._update(from, to, value - fee);
        if (fee != 0) super._update(from, feeRecipient, fee);
    }
}

/// @dev Attempts to call deposit() again while the router is pulling tokens.
/// The mock deliberately swallows the nested revert so the outer transfer can
/// finish and the test can inspect the ReentrancyGuard error selector.
contract ReentrantERC20 is MockERC20 {
    address public reentryTarget;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes4 public reentryRevertSelector;

    bool private _insideTransferFrom;

    constructor() MockERC20("Reentrant Pipedog", "RE-PIPEDOG") {}

    function configureReentry(address target) external {
        reentryTarget = target;
    }

    function armReentry() external {
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
        reentryRevertSelector = bytes4(0);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool transferred = super.transferFrom(from, to, value);

        if (armed && !_insideTransferFrom && msg.sender == reentryTarget && to == reentryTarget) {
            armed = false;
            _insideTransferFrom = true;
            reentryAttempted = true;
            bytes memory result;
            (reentrySucceeded, result) = reentryTarget.call(abi.encodeWithSignature("deposit(uint256)", 1));
            if (!reentrySucceeded && result.length >= 4) {
                bytes4 selector;
                assembly ("memory-safe") {
                    selector := mload(add(result, 0x20))
                }
                reentryRevertSelector = selector;
            }
            _insideTransferFrom = false;
        }

        return transferred;
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockV3Factory {
    address public tokenA;
    address public tokenB;
    uint24 public fee;
    address public pool;

    function configure(address tokenA_, address tokenB_, uint24 fee_, address pool_) external {
        tokenA = tokenA_;
        tokenB = tokenB_;
        fee = fee_;
        pool = pool_;
    }

    function getPool(address a, address b, uint24 requestedFee) external view returns (address) {
        bool pair = (a == tokenA && b == tokenB) || (a == tokenB && b == tokenA);
        return pair && requestedFee == fee ? pool : address(0);
    }
}

contract MockV3Pool {
    enum Mode {
        NORMAL,
        OVERCHARGE,
        DOUBLE_CALLBACK,
        WRONG_SIGN,
        RETURN_MISMATCH,
        EMPTY_OUTPUT
    }

    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public immutable factory;
    MockERC20 public immutable outputToken;
    bool public immutable wethIsToken0;
    Mode public mode;

    constructor(
        address token0_,
        address token1_,
        uint24 fee_,
        address factory_,
        MockERC20 outputToken_,
        bool wethIsToken0_
    ) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        factory = factory_;
        outputToken = outputToken_;
        wethIsToken0 = wethIsToken0_;
    }

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact input only");
        uint256 requested = uint256(amountSpecified);
        uint256 output = mode == Mode.EMPTY_OUTPUT ? 0 : requested * 2;

        if (mode == Mode.OVERCHARGE) {
            _callback(msg.sender, requested + 1, output);
        } else if (mode == Mode.DOUBLE_CALLBACK) {
            _callback(msg.sender, requested / 2, output);
            _callback(msg.sender, requested, output);
        } else if (mode == Mode.WRONG_SIGN) {
            if (wethIsToken0) {
                IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(int256(requested), 0, "");
            } else {
                IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(0, int256(requested), "");
            }
        } else {
            _callback(msg.sender, requested, output);
        }

        if (output > 0) outputToken.transfer(recipient, output);
        uint256 returnedInput = mode == Mode.RETURN_MISMATCH ? requested - 1 : requested;
        if (wethIsToken0) {
            return (int256(returnedInput), -int256(output));
        }
        return (-int256(output), int256(returnedInput));
    }

    function _callback(address caller, uint256 owed, uint256 output) private {
        if (wethIsToken0) {
            IUniswapV3SwapCallback(caller).uniswapV3SwapCallback(int256(owed), -int256(output), "");
        } else {
            IUniswapV3SwapCallback(caller).uniswapV3SwapCallback(-int256(output), int256(owed), "");
        }
    }
}

contract RejectNative {
    receive() external payable {
        revert("no");
    }
}
