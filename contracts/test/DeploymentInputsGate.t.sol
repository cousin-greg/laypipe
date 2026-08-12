// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployLaypipe} from "../script/DeployLaypipe.s.sol";

contract DeploymentInputsGateTest is Test {
    DeployLaypipe private deployScript;

    function setUp() public {
        deployScript = new DeployLaypipe();
    }

    function testDigestMatchesOffchainAbiSha256Vector() public view {
        string memory manifest = vm.readFile("test/fixtures/deployment-inputs-approved.json");
        bytes32 expected = vm.parseJsonBytes32(manifest, ".test.expectedDeploymentInputsHash");
        assertEq(deployScript.deploymentInputsDigest(manifest), expected);
    }

    function testPayloadMutationCannotReuseApprovedDigest() public view {
        string memory manifest = vm.readFile("test/fixtures/deployment-inputs-approved.json");
        bytes32 approved = vm.parseJsonBytes32(manifest, ".test.expectedDeploymentInputsHash");
        string memory mutated = vm.replace(manifest, '"routerBountyBps": 25', '"routerBountyBps": 26');
        assertNotEq(deployScript.deploymentInputsDigest(mutated), approved);
    }

    function testFullDeploymentInputGuardAcceptsExactApprovedVector() public view {
        string memory path = "test/fixtures/deployment-inputs-approved.json";
        string memory manifest = vm.readFile(path);
        bytes32 approved = vm.parseJsonBytes32(manifest, ".test.expectedDeploymentInputsHash");
        assertEq(
            vm.parseJsonBytes32(manifest, ".candidate.deployScriptRuntimeCodehash"), address(deployScript).codehash
        );
        deployScript.validateApprovedDeploymentInputs(manifest, approved, _inputs(manifest, 25));
    }

    function testRuntimeMutationCannotApproveDifferentExecutingScript() public {
        string memory original = vm.readFile("test/fixtures/deployment-inputs-approved.json");
        bytes32 approved = vm.parseJsonBytes32(original, ".test.expectedDeploymentInputsHash");
        string memory mutated = vm.replace(
            original,
            vm.toString(vm.parseJsonBytes32(original, ".candidate.deployScriptRuntimeCodehash")),
            "0x1111111111111111111111111111111111111111111111111111111111111111"
        );

        vm.expectRevert(DeployLaypipe.DeploymentInputsNotApproved.selector);
        deployScript.validateApprovedDeploymentInputs(mutated, approved, _inputs(mutated, 25));

        bytes32 mutatedDigest = deployScript.deploymentInputsDigest(mutated);
        mutated = vm.replace(
            mutated, vm.parseJsonString(mutated, ".approval.deploymentInputsHash"), _approvalString(mutatedDigest)
        );
        vm.expectRevert(DeployLaypipe.DeploymentInputsMismatch.selector);
        deployScript.validateApprovedDeploymentInputs(mutated, mutatedDigest, _inputs(mutated, 25));
    }

    function testFullGuardRejectsManifestAndMatchingInputMutationWithOldApproval() public {
        string memory original = vm.readFile("test/fixtures/deployment-inputs-approved.json");
        bytes32 approved = vm.parseJsonBytes32(original, ".test.expectedDeploymentInputsHash");
        string memory path = "test/fixtures/deployment-inputs-mutated.json";
        string memory mutated = vm.readFile(path);
        vm.expectRevert(DeployLaypipe.DeploymentInputsNotApproved.selector);
        deployScript.validateApprovedDeploymentInputs(mutated, approved, _inputs(mutated, 26));
    }

    function _inputs(string memory manifest, uint256 routerBountyBps)
        private
        pure
        returns (DeployLaypipe.ReviewedInputs memory inputs)
    {
        inputs = DeployLaypipe.ReviewedInputs({
            deployer: vm.parseJsonAddress(manifest, ".addresses.deployer"),
            finalOwner: vm.parseJsonAddress(manifest, ".addresses.finalOwner"),
            treasuryWallet: vm.parseJsonAddress(manifest, ".addresses.treasuryWallet"),
            operationsWallet: vm.parseJsonAddress(manifest, ".addresses.operationsWallet"),
            supply: vm.parseJsonUint(manifest, ".economics.supplyWei"),
            tickSpacing: vm.parseJsonInt(manifest, ".economics.tickSpacing"),
            startTick: vm.parseJsonInt(manifest, ".economics.startTick"),
            launchFee: vm.parseJsonUint(manifest, ".economics.launchFeePipedogWei"),
            sequesterCap: vm.parseJsonUint(manifest, ".economics.maxSequesterPerCallPipedogWei"),
            treasuryCap: vm.parseJsonUint(manifest, ".economics.maxTreasuryRoutePerCallPipedogWei"),
            selfBurnCap: vm.parseJsonUint(manifest, ".economics.maxSelfBurnPerCallPipedogWei"),
            routerBountyBps: routerBountyBps,
            selfBurnBountyBps: vm.parseJsonUint(manifest, ".economics.selfBurnBountyBps")
        });
    }

    function _approvalString(bytes32 digest) private pure returns (string memory) {
        bytes memory hexDigest = bytes(vm.toString(digest));
        bytes memory withoutPrefix = new bytes(hexDigest.length - 2);
        for (uint256 i; i < withoutPrefix.length; ++i) {
            withoutPrefix[i] = hexDigest[i + 2];
        }
        return string.concat("sha256:", string(withoutPrefix));
    }
}
