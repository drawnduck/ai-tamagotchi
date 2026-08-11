/**
 * Work around a genlayer-js gas bug that makes every write revert on Testnet Bradbury.
 *
 * THE BUG
 * -------
 * `_sendTransaction()` in genlayer-js 1.1.8 feeds the raw `eth_estimateGas` answer
 * straight into the transaction as its gas limit, with no safety buffer:
 *
 *     estimatedGas = await client.estimateTransactionGas({...})   // no multiplier
 *     ... { gas: estimatedGas } ...
 *
 * On Bradbury that limit is too tight to execute with. Measured on `AiPet.pet()`:
 *
 *     limit 841 511 (the raw estimate)  → REVERTED after burning 803 864
 *     limit 3 366 044 (estimate x4)     → SUCCESS, using only 795 361
 *
 * The successful run used LESS gas than the estimate, so the estimate itself is not
 * wrong — the transaction simply cannot complete when the limit sits that close to
 * the cost. The signature (revert at ~95% of the limit, well under it) is the EIP-150
 * 63/64 rule: the consensus contract makes an inner call, only 63/64 of the remaining
 * gas is forwarded, the inner frame runs out, and the outer frame reverts on the
 * failed call. Head-room, not a bigger estimate, is what fixes it.
 *
 * THE FIX
 * -------
 * genlayer-js exposes no gas parameter on `writeContract`/`deployContract`, and the
 * client's `estimateTransactionGas` cannot be monkey-patched (the send path closes
 * over an inner client object that `createClient` never returns). The one seam that
 * works in both Node and the browser is the RPC transport, which is plain global
 * `fetch` — so intercept `eth_estimateGas` there and multiply the answer.
 *
 * Call `installGasBuffer()` once, before creating the client.
 *
 * Delete this once genlayer-js applies its own buffer (it already has a
 * GAS_BUFFER_MULTIPLIER constant — just not on this code path).
 */

const DEFAULT_MULTIPLIER = 4n;

/**
 * @param {bigint|number} multiplier head-room factor applied to every gas estimate
 * @returns {() => void} restores the original fetch
 */
export function installGasBuffer(multiplier = DEFAULT_MULTIPLIER) {
  const factor = BigInt(multiplier);
  const original = globalThis.fetch;
  let blockLimit = null; // cached; one extra RPC call at most

  /** The ceiling the multiplied estimate must not cross. */
  async function ceiling(url) {
    if (blockLimit !== null) return blockLimit;
    try {
      const res = await original(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
      });
      const limit = BigInt((await res.json())?.result?.gasLimit ?? 0);
      // leave a little room: the node rejects at >, and estimates wobble
      blockLimit = limit > 0n ? (limit * 99n) / 100n : 0n;
    } catch {
      blockLimit = 0n; // unknown — better to send unclamped than to fail here
    }
    return blockLimit;
  }

  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    if (!isEstimateGasCall(init?.body)) return response;

    // Read the body through a clone so the original response stays intact if
    // anything below throws.
    let payload;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    if (typeof payload?.result !== "string") return response;

    // Multiply, then clamp to the block. A growing contract eventually makes
    // estimate x4 exceed the block gas limit and the node rejects the transaction
    // outright ("gas limit N exceeds block's gas limit M") — measured once
    // contracts/ai_pet.py reached ~750 lines. Take whatever head-room fits.
    const raw = BigInt(payload.result);
    const cap = await ceiling(input);
    let buffered = raw * factor;
    if (cap > 0n && buffered > cap) buffered = cap > raw ? cap : raw;
    payload.result = `0x${buffered.toString(16)}`;
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return () => {
    globalThis.fetch = original;
  };
}

function isEstimateGasCall(body) {
  if (typeof body !== "string" || !body.includes("eth_estimateGas")) return false;
  try {
    return JSON.parse(body).method === "eth_estimateGas";
  } catch {
    return false;
  }
}
