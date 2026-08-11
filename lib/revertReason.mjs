/**
 * Pull the human-readable reason out of a GenVM revert.
 *
 * THE PROBLEM
 * -----------
 * When a contract raises `gl.vm.UserError("pet is dead — call revive() …")`, what
 * reaches the caller through genlayer-js is a viem `InvalidInputRpcError` whose
 * `message` is the generic "Missing or invalid parameters." The actual text is
 * buried in `cause.data` — a hex blob of the calldata-encoded VM result, several
 * kilobytes of Rust struct dump with the message somewhere inside:
 *
 *   2e0464617461 a401 "pet is already alive" 066576656e7473 …
 *      ^ "data"   ^ len  ^ what we want
 *
 * Showing that to a user, or asserting on it in a test, is useless.
 *
 * THE APPROACH
 * ------------
 * Decode the hex and keep the printable runs, minus the framing words the encoder
 * always emits ("data", "events", "cpython", "storage_changes", …). What is left is
 * the contract's own message. This is deliberately loose: a precise calldata decoder
 * would have to track the SDK's wire format, and this only needs to produce
 * something readable — never to be parsed for control flow.
 */

// Structural noise the VM result always contains, in encounter order.
const FRAMING = new Set([
  "data",
  "events",
  "fingerprint",
  "frames",
  "func",
  "module_name",
  "module_instances",
  "cpython",
  "memories",
  "softfloat",
  "kind",
  "UserError",
  "VmError",
  "storage_changes",
  "genvm",
  "stdout",
  "stderr",
]);

/**
 * @param err an error thrown by writeContract / simulateWriteContract
 * @returns the contract's revert message, or the original error message if none
 *          could be recovered
 */
export function revertReason(err) {
  const hex = err?.cause?.data ?? err?.data;
  const fallback = err?.shortMessage ?? err?.message ?? String(err);
  if (typeof hex !== "string") return fallback;

  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) return fallback;

  // UTF-8, not latin1: the contract's own messages contain em dashes, and
  // splitting on them would cut "pet is dead — call revive()…" in half.
  const text = Buffer.from(clean, "hex").toString("utf8");
  const runs = (text.match(/[^\x00-\x1f\x7f-\x9f�]{4,}/g) ?? [])
    .map((r) => r.trim())
    .filter((r) => !FRAMING.has(r));

  // The contract's message is the longest thing that is not framing.
  const best = runs.sort((a, b) => b.length - a.length)[0];
  return best ?? fallback;
}
