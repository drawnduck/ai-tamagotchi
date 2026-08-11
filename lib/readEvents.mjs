/**
 * Read the events a contract call emits. genlayer-js throws them away.
 *
 * THE PROBLEM
 * -----------
 * `gl.Event.emit()` works: GenVM collects the events and the node returns them in
 * the `gen_call` result, alongside `data`, `logs` and `messages`. But
 * `simulateWriteContract()` returns only the decoded `data`, so nothing in the
 * client surfaces them — and on Testnet Bradbury they never reach EVM logs either:
 * an `eth_getLogs` sweep for all five AiPet topics over 2000 blocks, after the
 * transaction had FINALIZED with vote AGREE, found nothing. The only place they
 * exist is that raw RPC response.
 *
 * WHAT THIS GIVES YOU, AND WHAT IT DOES NOT
 * -----------------------------------------
 * This runs the call in *simulation* — the same GenVM code, no consensus, no gas —
 * and reports the events it produced. That answers "what does this action emit",
 * which is enough to verify the wiring and to preview an action before sending it.
 *
 * It is NOT a historical feed: there is no way to ask the chain for the events of
 * a transaction that already settled, because `getTransaction()` has no events
 * field and the logs are not on chain. Until such a path exists, a UI that wants
 * to react to what actually happened still has to poll state.
 */
import { abi } from "genlayer-js";

/**
 * @param client   a genlayer-js client
 * @param call     {address, functionName, args?, account?}
 * @returns array of {topic, indexed, blob} — blob is the decoded keyword payload
 *
 * No `value`: `simulateWriteContract` has no such parameter, so a simulated
 * `feed()` always looks like a 0-GEN feed and emits no `PetFed`. Accepting one
 * here and quietly dropping it would be worse than not offering it.
 */
export async function simulateEvents(client, { address, functionName, args = [], account }) {
  const events = [];

  // The client offers no seam for this — simulateWriteContract drops the field
  // before we ever see it — so read the response off the transport, the same way
  // lib/gasBuffer.mjs adjusts the gas estimate.
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    try {
      if (typeof init?.body === "string" && JSON.parse(init.body).method === "gen_call") {
        const payload = await response.clone().json();
        for (const raw of payload?.result?.events ?? []) events.push(decodeEvent(raw));
      }
    } catch {
      /* a malformed response is the caller's problem, not ours */
    }
    return response;
  };

  try {
    await client.simulateWriteContract({ address, functionName, args, ...(account ? { account } : {}) });
  } finally {
    globalThis.fetch = original;
  }
  return events;
}

/** Decode one raw event: keep the topics, turn the calldata blob into an object. */
export function decodeEvent(raw) {
  const [topic, ...indexed] = raw.topics ?? [];
  let blob = null;
  try {
    const hex = String(raw.data ?? "").replace(/^0x/, "");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    blob = normalise(abi.calldata.decode(bytes));
  } catch (err) {
    blob = { _undecodable: String(err.message ?? err) };
  }
  return { topic, indexed, blob };
}

/** Make the decoded payload printable and JSON-safe.
 *
 * `calldata.decode` returns a **Map**, not a plain object — treating it as one
 * silently yields `{}`, which is exactly the empty blob this first shipped with.
 * Addresses arrive as byte arrays and numbers as bigints; both need converting.
 */
function normalise(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return `0x${[...value].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([k, v]) => [k, normalise(v)]));
  }
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    // Address and friends carry their bytes on .bytes / .as_hex
    if (value.bytes instanceof Uint8Array) return normalise(value.bytes);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}
