/**
 * Two AiPets on Bradbury, talking to each other.
 *
 *   npm run demo:twopets                 # deploy a fresh pair and introduce them
 *   npm run demo:twopets -- 0xGUEST 0xHOST   # reuse two already deployed pets
 *
 * WHAT THIS PROVES that direct mode cannot: a visit is three separate mechanisms
 * and only the middle one runs inside the visitor's own VM.
 *
 *   1. `visit()` reads the host with a cross-contract VIEW call, from FINALIZED
 *      state, and refuses anything that does not answer like a pet;
 *   2. an LLM writes a line addressed to that host by name;
 *   3. the line is delivered by a consensus MESSAGE to `receive_visit`, which
 *      runs later, inside the HOST's contract, on its own.
 *
 * Step 3 is the one that has to be seen to be believed — `PostMessage` is a
 * silent no-op in direct mode, which is exactly how a `withdraw()` that paid
 * nobody once passed 27 green tests.
 *
 * WHY THE WAITING. Both pets must FINALIZE before either can visit: the
 * neighbour read is pinned to LATEST_FINAL so that every validator sees the same
 * neighbour. On Bradbury that is ~25-35 min per deploy, and the two run
 * concurrently. Everything is resumable — pass the two addresses back in.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { buildContract } from "../lib/buildContract.mjs";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import {
  waitForSettled,
  waitForFinalized,
  statusName,
  succeeded,
  outcome,
} from "../lib/waitForSettled.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(HERE, "../contracts/ai_pet.py");
const ENV = path.resolve(HERE, "../.env");

// The DEPLOY ARTIFACT, not the source: Bradbury refuses a deploy over ~52 KB and
// contracts/ai_pet.py is past that with its comments. See lib/buildContract.mjs.
const built = buildContract(CONTRACT);
const contractCode = built.code;

// One knob short of identical, so the lines they produce are clearly two voices.
const GUEST = ["Pixel", "a sleepy philosopher cat who speaks in riddles", "Lisbon"];
const HOST = ["Kuzya", "a boisterous street dog who is delighted by everything", "Tbilisi"];

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
const gen = (wei) => `${(Number(wei) / 1e18).toFixed(4)} GEN`;

console.log(
  `account ${account.address}  balance ${gen(await client.getBalance({ address: account.address }))}`,
);

const read = (address, fn, args = []) => client.readContract({ address, functionName: fn, args });

async function send(address, fn, { args = [], value = 0n, label = fn } = {}) {
  const hash = await client.writeContract({ address, functionName: fn, args, value });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    ${label} … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
    timeoutMs: 1_200_000,
  });
  if (!succeeded(tx)) throw new Error(`${label} did not take effect — ${outcome(tx)}`);
  console.log(`\r    ${label} ✅ ${outcome(tx)}${" ".repeat(20)}`);
  await new Promise((r) => setTimeout(r, 4000)); // reads trail the verdict by a beat
  return tx;
}

/** Deploy one pet; returns {address, hash} without waiting for finalization. */
async function deploy(ctor, label) {
  const hash = await client.deployContract({
    code: contractCode,
    args: ctor,
  });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    deploy ${label} … ${statusName(s)} ${(ms / 1000).toFixed(0)}s   `),
    timeoutMs: 1_800_000,
  });
  if (!succeeded(tx)) throw new Error(`deploy ${label} did not take effect — ${outcome(tx)}`);
  const address = tx.recipient ?? tx.data?.contract_address ?? tx.txDataDecoded?.contractAddress;
  if (!address) throw new Error(`no contract address in the ${label} receipt`);
  console.log(`\r    deploy ${label} ✅ ${address}${" ".repeat(20)}`);
  return { address, hash };
}

async function show(address, label) {
  const [s, social] = await Promise.all([read(address, "get_state"), read(address, "get_social")]);
  console.log(`\n=== ${label} — ${s.name} ===`);
  console.log(`  🐾 "${s.last_quote}"`);
  console.log(
    `  satiety ${s.satiety} | mood ${s.mood} | health ${s.health} | ${s.stage} | alive ${s.alive}`,
  );
  console.log(
    `  friends ${social.friends} | sent ${social.visits_sent} | received ${social.visits_received}` +
      (social.pending_name ? ` | unanswered guest: ${social.pending_name}` : ""),
  );
  return { s, social };
}

// --------------------------------------------------------------------------- //

let [guestAddr, hostAddr] = process.argv.slice(2);

if (guestAddr && hostAddr) {
  console.log(`reusing ${guestAddr} (guest) and ${hostAddr} (host)`);
} else {
  // One at a time, deliberately. Both deploys come from the same account, and
  // firing them concurrently hands them the same nonce — the node rejects the
  // second with "insufficient gas price to replace existing transaction" and the
  // first is left in flight with nobody holding its hash. Measured, once.
  console.log("\ndeploying two pets, one after the other…");
  const guest = await deploy(GUEST, "Pixel");
  const host = await deploy(HOST, "Kuzya");
  guestAddr = guest.address;
  hostAddr = host.address;

  console.log("\nwaiting for BOTH deploys to finalize — a neighbour is read from");
  console.log("finalized state, so neither pet can see the other before then.");
  console.log("(~25-35 min on Bradbury; both are waiting at the same time)");
  const t0 = Date.now();
  await Promise.all(
    [guest, host].map(({ hash }, i) =>
      waitForFinalized(client, hash, {
        onProgress: (s, ms) =>
          console.log(
            `    ${["Pixel", "Kuzya"][i]}: ${statusName(s)} at ${(ms / 1000 / 60).toFixed(1)} min`,
          ),
      }),
    ),
  );
  console.log(`    both finalized after ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`\n    resume any time with:\n      npm run demo:twopets -- ${guestAddr} ${hostAddr}`);
}

await show(guestAddr, "before");
await show(hostAddr, "before");

console.log(`\n>>> Pixel visits Kuzya`);
console.log("    a view call reads the host, an LLM greets it by name, a message carries the line");
const visitTx = await send(guestAddr, "visit", { args: [hostAddr], label: "visit()" });

const { s: guestAfter } = await show(guestAddr, "after visit()");
console.log(`\n    Pixel said: "${guestAfter.last_quote}"`);

// The greeting is a separate transaction the consensus layer issues once visit()
// is accepted. It executes inside Kuzya's contract, so the only honest way to
// confirm it is to read Kuzya until the guest shows up.
console.log("\n>>> waiting for the greeting to be delivered to Kuzya…");
console.log("    (`on: accepted`, so this is seconds-to-minutes, not finalization)");
const deadline = Date.now() + 900_000;
let delivered = null;
for (;;) {
  const social = await read(hostAddr, "get_social");
  if (Number(social.visits_received) > 0) {
    delivered = social;
    break;
  }
  if (Date.now() > deadline) {
    console.error("    the greeting never arrived within 15 min.");
    console.error(`    inspect the visit tx: node tools/watchTx.mjs ${visitTx.txId ?? "<txId>"}`);
    process.exit(1);
  }
  process.stdout.write(`\r    …${((deadline - Date.now()) / 1000).toFixed(0)}s left   `);
  await new Promise((r) => setTimeout(r, 10_000));
}

console.log(`\r    ✅ delivered${" ".repeat(20)}`);
console.log(`    Kuzya heard from: ${delivered.pending_name}`);
console.log(`    "${delivered.pending_quote}"`);
await show(hostAddr, "after being greeted");

console.log("\n>>> pet(Kuzya) — the host answers, knowing who came by");
await send(hostAddr, "pet", { label: "pet()" });
const { s: hostAfter, social: hostSocial } = await show(hostAddr, "after answering");
console.log(`\n    Kuzya replied: "${hostAfter.last_quote}"`);
console.log(
  `    unanswered guest cleared: ${hostSocial.pending_name === "" ? "yes" : `no (${hostSocial.pending_name})`}`,
);

console.log("\n--- Kuzya's friends ---");
for (const f of await read(hostAddr, "get_friends", [0])) {
  console.log(`  ${f.address}  ${f.meetings} meeting(s)`);
}

console.log("\n--- Kuzya's feed ---");
for (const [i, q] of (await read(hostAddr, "get_history")).entries()) console.log(`  ${i + 1}. ${q}`);

console.log(`\nguest ${guestAddr}\nhost  ${hostAddr}`);
