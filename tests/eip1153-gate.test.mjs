import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_PROBE_RESULT,
  INVALID_OPCODE_CONTROL_INITCODE,
  TRANSIENT_STORAGE_PROBE_INITCODE,
  runRobinhoodEip1153Gate,
} from "../contracts/scripts/check-robinhood-eip1153.mjs";

const BLOCK_NUMBER = "0x2096fd9";
const BLOCK_HASH = `0x${"ab".repeat(32)}`;

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function createMockRpc({
  chainId = "0x1237",
  probeResult = EXPECTED_PROBE_RESULT,
  controlError = { code: -32000, message: "invalid opcode: INVALID" },
} = {}) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);

    let response;
    switch (request.method) {
      case "eth_chainId":
        response = { result: chainId };
        break;
      case "web3_clientVersion":
        response = { result: "nitro/test" };
        break;
      case "eth_getBlockByNumber":
        response = { result: { number: BLOCK_NUMBER, hash: BLOCK_HASH } };
        break;
      case "eth_call": {
        const initcode = request.params[0].data;
        if (initcode === TRANSIENT_STORAGE_PROBE_INITCODE) {
          response = { result: probeResult };
        } else if (initcode === INVALID_OPCODE_CONTROL_INITCODE) {
          response = controlError ? { error: controlError } : { result: "0x" };
        } else {
          throw new Error(`Unexpected initcode ${initcode}`);
        }
        break;
      }
      default:
        throw new Error(`Unexpected RPC method ${request.method}`);
    }

    return jsonResponse({
      jsonrpc: "2.0",
      id: request.id,
      ...response,
    });
  };
  return { calls, fetchImpl };
}

test("EIP-1153 gate binds semantic and control calls to one canonical block hash", async () => {
  const mock = createMockRpc();
  const report = await runRobinhoodEip1153Gate({
    rpcUrl: "https://rpc.example.test",
    fetchImpl: mock.fetchImpl,
  });

  assert.equal(report.ok, true);
  assert.equal(report.chainId, 4663);
  assert.equal(report.pinnedBlockNumber, BigInt(BLOCK_NUMBER).toString(10));
  assert.equal(report.pinnedBlockHash, BLOCK_HASH);
  assert.equal(report.probeResult, EXPECTED_PROBE_RESULT);
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    [
      "eth_chainId",
      "web3_clientVersion",
      "eth_getBlockByNumber",
      "eth_call",
      "eth_call",
    ],
  );

  const [semanticCall, controlCall] = mock.calls.slice(-2);
  const expectedPinnedBlock = {
    blockHash: BLOCK_HASH,
    requireCanonical: true,
  };
  assert.deepEqual(semanticCall.params, [
    {
      from: "0x0000000000000000000000000000000000000001",
      data: TRANSIENT_STORAGE_PROBE_INITCODE,
    },
    expectedPinnedBlock,
  ]);
  assert.deepEqual(controlCall.params, [
    {
      from: "0x0000000000000000000000000000000000000001",
      data: INVALID_OPCODE_CONTROL_INITCODE,
    },
    expectedPinnedBlock,
  ]);
});

test("EIP-1153 gate fails closed on the wrong chain before probing", async () => {
  const mock = createMockRpc({ chainId: "0x1" });

  await assert.rejects(
    runRobinhoodEip1153Gate({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: mock.fetchImpl,
    }),
    /expected Robinhood Chain 4663, received 1/,
  );
  assert.deepEqual(
    mock.calls.map(({ method }) => method),
    ["eth_chainId"],
  );
});

test("EIP-1153 gate rejects insecure RPC endpoints before any request", async () => {
  let calls = 0;
  await assert.rejects(
    runRobinhoodEip1153Gate({
      rpcUrl: "http://rpc.example.test",
      fetchImpl: async () => {
        calls += 1;
      },
    }),
    /secure HTTPS endpoint/,
  );
  assert.equal(calls, 0);
});

test("EIP-1153 gate fails closed when TSTORE/TLOAD semantics are wrong", async () => {
  const mock = createMockRpc({ probeResult: `0x${"0".repeat(64)}` });

  await assert.rejects(
    runRobinhoodEip1153Gate({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: mock.fetchImpl,
    }),
    /semantic probe returned/,
  );
  assert.equal(mock.calls.at(-1).params[0].data, TRANSIENT_STORAGE_PROBE_INITCODE);
});

test("EIP-1153 gate requires a real invalid-opcode JSON-RPC control failure", async () => {
  const successfulControl = createMockRpc({ controlError: null });
  await assert.rejects(
    runRobinhoodEip1153Gate({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: successfulControl.fetchImpl,
    }),
    /control unexpectedly succeeded/,
  );

  const unrelatedRpcError = createMockRpc({
    controlError: { code: -32005, message: "rate limit exceeded" },
  });
  await assert.rejects(
    runRobinhoodEip1153Gate({
      rpcUrl: "https://rpc.example.test",
      fetchImpl: unrelatedRpcError.fetchImpl,
    }),
    /did not fail with a JSON-RPC invalid-opcode error/,
  );
});
