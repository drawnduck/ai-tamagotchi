/**
 * Wait for a GenLayer transaction to really settle, not merely to stop moving.
 *
 * THE BUG
 * -------
 * genlayer-js 1.1.8 lists LEADER_TIMEOUT (13) and VALIDATORS_TIMEOUT (12) in its
 * DECIDED_STATES, so `waitForTransactionReceipt({status: "ACCEPTED"})` returns as
 * soon as it sees one and reports the transaction as done-but-not-voted.
 *
 * On Bradbury those states are transient: consensus rotates to a new leader and the
 * transaction is retried, up to `chain.defaultConsensusMaxRotations` (3) times.
 * Measured directly — two `feed()` calls that this client reported as
 * `13 / NOT_VOTED` both landed a few seconds later, moving satiety and
 * `total_fed_wei` exactly as expected. Trusting the early return means reporting
 * a success as a failure, and reading state before the write has applied.
 *
 * THE FIX
 * -------
 * Poll `getTransaction` ourselves and keep going through the timeout states until
 * the transaction reaches a genuinely final one.
 */

// Everything not listed here is treated as still in flight — including
// VALIDATORS_TIMEOUT (12), LEADER_TIMEOUT (13) and LEADER_REVEALING (14), which is
// the whole point of this module.
const FINAL = new Set([
  "5", // ACCEPTED
  "6", // UNDETERMINED
  "7", // FINALIZED
  "8", // CANCELED
]);

const STATUS_NAME = {
  5: "ACCEPTED",
  6: "UNDETERMINED",
  7: "FINALIZED",
  8: "CANCELED",
  12: "VALIDATORS_TIMEOUT",
  13: "LEADER_TIMEOUT",
  14: "LEADER_REVEALING",
};

export const statusName = (s) => STATUS_NAME[Number(s)] ?? `status ${s}`;

// The VOTE outcome, which is a different thing from the status and from the
// execution result. 0 = IDLE means the round never reached a verdict.
const VOTE_AGREED = new Set([1 /* AGREE */, 6 /* MAJORITY_AGREE */]);

/**
 * Did this transaction actually take effect?
 *
 * A settled status is NOT enough, and neither is the execution result. Measured on
 * Bradbury, two transactions both reporting `status 7 (FINALIZED)` and
 * `txExecutionResultName: FINISHED_WITH_RETURN`:
 *
 *   result 1 (AGREE), 0 rounds  → the withdraw that really paid out
 *   result 0 (IDLE),  3 rounds  → a deploy that produced no contract at all
 *
 * FINALIZED here means "consensus is done arguing", not "it worked" — a
 * transaction abandoned after rotating through its rounds finalizes as IDLE. Judge
 * on the vote.
 */
export function succeeded(tx) {
  if (!FINAL.has(String(tx?.status ?? ""))) return false;
  if (!VOTE_AGREED.has(Number(tx.result))) return false;
  const exec = tx.txExecutionResultName ?? tx.txExecutionResult;
  return exec === undefined || exec === "FINISHED_WITH_RETURN";
}

/** Why `succeeded()` said no — for error messages. */
export function outcome(tx) {
  return `${statusName(tx?.status)} / vote ${tx?.resultName ?? tx?.result} / ${
    tx?.txExecutionResultName ?? tx?.txExecutionResult ?? "?"
  }`;
}

/**
 * Wait for FINALIZED specifically, not merely settled.
 *
 * ACCEPTED is enough for most things — the state has changed and reads see it.
 * Two things in this contract need more than that:
 *
 *   * `withdraw()` — the payout is a consensus-dispatched message that is issued
 *     at finalization, so the money has not moved at ACCEPTED;
 *   * `visit()` — a pet's neighbour is read from LATEST_FINAL state, so a freshly
 *     deployed pet is invisible to its neighbours until its deploy finalizes.
 *
 * Measured on Bradbury: roughly 25-35 minutes after acceptance.
 *
 * @returns the transaction once status is FINALIZED
 * @throws  if it settles into a final-but-not-finalized state (CANCELED / UNDETERMINED)
 */
export async function waitForFinalized(client, hash, opts = {}) {
  const { onProgress, intervalMs = 15_000, timeoutMs = 3_600_000 } = opts;
  const started = Date.now();
  let last = null;

  for (;;) {
    const tx = await client.getTransaction({ hash });
    const status = String(tx?.status ?? "");

    if (status !== last) {
      last = status;
      onProgress?.(status, Date.now() - started);
    }
    if (status === "7") return tx;
    if (status === "8" || status === "6") {
      throw new Error(`transaction ${hash} will never finalize — ${outcome(tx)}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`transaction ${hash} still ${statusName(status)} after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * @param client   a genlayer-js client
 * @param hash     the GenLayer transaction hash
 * @param opts     {onProgress, intervalMs, timeoutMs} — NOT a bare callback
 * @returns the transaction once it reaches a final status
 */
export async function waitForSettled(client, hash, opts = {}) {
  if (typeof opts === "function") {
    throw new TypeError("waitForSettled takes an options object: {onProgress}");
  }
  const { onProgress, intervalMs = 3000, timeoutMs = 600_000 } = opts;
  const started = Date.now();
  let last = null;

  for (;;) {
    // A dropped connection while polling is not a failed transaction. Measured:
    // an `ECONNRESET` from the RPC endpoint mid-wait used to throw out of here
    // and be reported as if the transaction had died, while it was still in
    // consensus. Keep polling; only the timeout decides when to give up.
    let tx;
    try {
      tx = await client.getTransaction({ hash });
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const status = String(tx?.status ?? "");

    if (status !== last) {
      last = status;
      onProgress?.(status, Date.now() - started);
    }
    if (FINAL.has(status)) return tx;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`transaction ${hash} still ${statusName(status)} after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
