/**
 * Register a pet into a directory as soon as the pet is actually FINALIZED.
 *
 *   node tools/registerWhenFinal.mjs 0xDIRECTORY 0xPET
 *
 * WHY THIS EXISTS. `AiPetFactory.register()` reads the candidate through
 * `StorageType.LATEST_FINAL` — only finalized state is agreed on by every
 * validator (see the contract). A pet whose DEPLOY has not finalized cannot be
 * read that way at all, and on Bradbury finalization is not a predictable
 * ~30 minutes: it has been observed stalling for hours (ROADMAP §3b). Retrying
 * `register()` on a timer therefore spends a reverted transaction per guess.
 *
 * WHAT IT POLLS, AND THE WRONG ANSWER I TRIED FIRST. The obvious poll is to
 * read the pet at `transactionHashVariant: "latest-final"` from here and
 * register once that answers. It answers far too early: the node served
 * `get_state()` and `get_owner()` for a pet whose deploy was still ACCEPTED,
 * and the register that followed failed anyway. The failure is not the pet
 * answering wrongly — the sub-VM never starts. Decoding the `ReturnData` of
 * that reverted call gives:
 *
 *     invalid_contract absent_runner_comment
 *
 * i.e. from inside a contract, at finalized state, the pet's CODE is not there
 * yet. The two reads are not the same read, and only one of them is the one
 * `register()` makes.
 *
 * So this polls the actual call — a free `readContract` of `register` itself,
 * which runs the whole method including the cross-contract read — and sends the
 * write only once that simulation stops failing. One transaction, no guessing.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { waitForSettled, statusName, succeeded, outcome } from "../lib/waitForSettled.mjs";

const [directory, pet] = process.argv.slice(2);
if (!directory || !pet) {
  console.error("usage: node tools/registerWhenFinal.mjs 0xDIRECTORY 0xPET");
  process.exit(1);
}

const ENV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const POLL_MS = 30_000;
const GIVE_UP_MS = 3 * 60 * 60 * 1000; // Bradbury has stalled for hours before

installGasBuffer();

const pk = readFileSync(ENV, "utf8").match(
  /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
)?.[1];
if (!pk) {
  console.error(`No PRIVATE_KEY=0x… line in ${ENV}. Use a throwaway testnet key.`);
  process.exit(1);
}

const account = createAccount(pk);
const client = createClient({ chain: testnetBradbury, account });

if (await client.readContract({ address: directory, functionName: "is_registered", args: [pet] })) {
  console.log(`${pet} is already in the directory.`);
  process.exit(0);
}

// genlayer-js console.errors the whole VMResult — hundreds of lines of Go struct
// dump — on every failed gen_call. That is exactly what we expect once per poll,
// so it is muted around the simulation and restored for anything real.
const realError = console.error;
const muted = (fn) => async (...a) => {
  console.error = () => {};
  try {
    return await fn(...a);
  } finally {
    console.error = realError;
  }
};

/** The reason the last simulation failed, short enough to print on one line.
 *
 * genlayer-js buries the useful part: `err.message` is the generic "Missing or
 * invalid parameters", and the VM's own words are in `details` / `cause` /
 * `shortMessage`. Reading only `message` prints a label that is true of nothing
 * — which is the same class of mistake that cost five reverted transactions
 * here already (ROADMAP §3b). So flatten the whole object and search that.
 */
function why(err) {
  const text = [err?.message, err?.shortMessage, err?.details, err?.cause?.message, String(err)]
    .filter(Boolean)
    .join(" ");
  if (text.includes("absent_runner_comment")) return "pet code not final yet (sub-VM won't start)";
  const named = text.match(/does not answer like an AiPet|already registered|admin-only/);
  return named ? named[0] : String(err?.message ?? err).slice(0, 70).replace(/\s+/g, " ");
}

console.log(`waiting until register() can succeed (simulating every ${POLL_MS / 1000}s)…`);
const started = Date.now();
let ready = false;
while (!ready) {
  if (Date.now() - started > GIVE_UP_MS) {
    console.error(`\ngave up after ${((Date.now() - started) / 60000).toFixed(0)} min.`);
    process.exit(1);
  }
  try {
    // A read of a write method: the node runs the whole thing, including the
    // cross-contract call at LATEST_FINAL, and changes nothing.
    await muted(client.readContract)({ address: directory, functionName: "register", args: [pet] });
    ready = true;
  } catch (err) {
    // Not every failure is "wait longer". If a register from an earlier run
    // landed in the meantime — or the client was killed after submitting one,
    // which does not cancel it — the work is done and polling would never end.
    if (why(err) === "already registered") {
      console.log(`\n${pet} is already in the directory.`);
      process.exit(0);
    }
    process.stdout.write(
      `\r    ${((Date.now() - started) / 60000).toFixed(1)} min — ${why(err)}${" ".repeat(20)}`,
    );
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log(`\nregister() simulates clean after ${((Date.now() - started) / 60000).toFixed(1)} min — sending it.`);

const hash = await client.writeContract({ address: directory, functionName: "register", args: [pet] });
const tx = await waitForSettled(client, hash, {
  onProgress: (s, ms) =>
    process.stdout.write(`\r    register() … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
  timeoutMs: 1_200_000,
});
if (!succeeded(tx)) {
  console.error(`\nregister() did not take effect — ${outcome(tx)}`);
  process.exit(1);
}
console.log(`\r    register() ✅ ${outcome(tx)}${" ".repeat(24)}`);

await new Promise((r) => setTimeout(r, 4000));
const info = await client.readContract({ address: directory, functionName: "get_info" });
console.log(`\ndirectory now holds ${info.pets} pet(s): ${JSON.stringify(info)}`);
for (const [i, r] of (
  await client.readContract({ address: directory, functionName: "get_leaderboard", args: [0, 0] })
).entries()) {
  console.log(
    `  ${i + 1}. ${r.name}  ${(Number(r.total_fed_wei) / 1e18).toFixed(4)} GEN  ` +
      `${r.stage} ${r.age_days}d  mood ${r.mood}${r.alive ? "" : "  💀"}`,
  );
  console.log(`     ${r.address}`);
}
console.log("REGISTERED-OK");
