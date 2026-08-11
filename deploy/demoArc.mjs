/**
 * The whole life cycle on Testnet Bradbury, in about five minutes:
 * hatch → neglect → starve → die → pay to revive.
 *
 *   npm run demo:bradbury
 *   npm run demo:bradbury -- 0x…   # resume against a pet already deployed
 *
 * At real speed this takes 150 hours, which is why it had never been shown on a
 * live network. The pet is deployed with `time_scale = 3600`, so one real second
 * is one virtual hour — every rate in the contract is untouched, only the clock
 * moves faster. See AiPet.__init__.
 *
 * Costs 1 GEN for the revive, plus gas.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { buildContract } from "../lib/buildContract.mjs";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { revertReason } from "../lib/revertReason.mjs";
import { waitForSettled, statusName, succeeded, outcome } from "../lib/waitForSettled.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(HERE, "../contracts/ai_pet.py");
const ENV = path.resolve(HERE, "../.env");

// The DEPLOY ARTIFACT, not the source: Bradbury refuses a deploy over ~52 KB and
// contracts/ai_pet.py is past that with its comments. See lib/buildContract.mjs.
const built = buildContract(CONTRACT);
const contractCode = built.code;

const CTOR = ["Ash", "a stoic little dragon who speaks in short sentences", "Reykjavik"];
const TIME_SCALE = 3600; // one real second == one virtual hour
const NEGLECT_S = 155; // 150 virtual hours starves it to death; a margin on top

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

let address;

async function send(fn, { args = [], value = 0n } = {}) {
  const hash = await client.writeContract({ address, functionName: fn, args, value });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    ${fn}() … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
    timeoutMs: 1_200_000, // Bradbury can be slow; giving up early strands the arc
  });
  const ok = succeeded(tx);
  console.log(`\r    ${fn}() ${ok ? "✅" : "❌"} ${outcome(tx)}${" ".repeat(20)}`);
  if (!ok) throw new Error(`${fn}() did not take effect — ${outcome(tx)}`);
  await new Promise((r) => setTimeout(r, 4000)); // readable state trails the verdict
  return tx;
}

const read = (fn, args = []) => client.readContract({ address, functionName: fn, args });

async function show(label) {
  const s = await read("get_state");
  console.log(`\n=== ${label} ===`);
  if (s.last_quote) console.log(`  🐾 "${s.last_quote}"`);
  console.log(
    `  ${s.alive ? "alive" : "💀 DEAD"} | satiety ${s.satiety} | mood ${s.mood} | ` +
      `health ${s.health} | ${s.stage} ${s.age_days}d | revives ${s.revives}`,
  );
  return s;
}

// --------------------------------------------------------------------------- //

console.log(`account ${account.address}  balance ${gen(await client.getBalance({ address: account.address }))}`);

if (process.argv[2]) {
  address = process.argv[2];
  console.log(`resuming against ${address}`);
} else {
  console.log(`\ndeploying a demo pet (time_scale ${TIME_SCALE} — 1 real second = 1 virtual hour)…`);
  const deployTx = await waitForSettled(
    client,
    await client.deployContract({ code: contractCode, args: [...CTOR, TIME_SCALE] }),
    {
      onProgress: (s, ms) => process.stdout.write(`\r    deploy … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
      // A deploy carries the whole contract and can sit in PROPOSING for many
      // minutes when Bradbury is busy — measured at 10 min and still climbing.
      // Failing there would strand a contract that is about to exist, so wait.
      timeoutMs: 1_800_000,
    },
  );
  // A deploy can finalize with vote IDLE: an address comes back but nothing was
  // deployed there. Measured twice on 2026-08-04 (ROADMAP §3b).
  if (!succeeded(deployTx)) {
    console.error(`\ndeploy did not take effect — ${outcome(deployTx)}`);
    process.exit(1);
  }
  address = deployTx.recipient;
  if (!address) {
    console.error("\nno contract address in receipt");
    process.exit(1);
  }
  console.log(`\ndeployed: ${address}`);
}

const born = await show("just hatched");
if (Number(born.time_scale) !== TIME_SCALE) {
  console.error(`time_scale did not stick: ${born.time_scale}`);
  process.exit(1);
}

console.log(`\n>>> now we do nothing for ${NEGLECT_S}s — ${NEGLECT_S} virtual hours of neglect`);
for (let left = NEGLECT_S; left > 0; left -= 15) {
  process.stdout.write(`\r    ignoring the pet … ${left}s left      `);
  await new Promise((r) => setTimeout(r, Math.min(15, left) * 1000));
}
console.log("\r    the pet has been alone for a very long time.        ");

console.log("\n>>> pet() — the action itself applies the fatal drift");
await send("pet");
const dead = await show("after the neglect");
if (dead.alive) {
  console.error("expected the pet to be dead by now — check NEGLECT_S against the decay rates");
  process.exit(1);
}

console.log("\n>>> a dead pet rejects every action");
try {
  await client.simulateWriteContract({ address, functionName: "play", args: [] });
  console.log("    ❌ play() went through, which it should not have");
} catch (err) {
  console.log(`    ✅ play() reverted: "${revertReason(err)}"`);
}

const cost = BigInt((await read("get_state")).revive_cost_wei);
console.log(`\n>>> revive() — paying ${gen(cost)} to bring it back`);
await send("revive", { value: cost });
const back = await show("revived");

console.log(`\ncontract now holds ${gen(await client.getBalance({ address }))} (the revive fee)`);
console.log(`revives: ${back.revives} | alive: ${back.alive}`);
console.log(`\nDemo pet: ${address} — paste it into the frontend (network: testnetBradbury).`);
