/**
 * Watch a pet grow a character on Testnet Bradbury.
 *
 *   npm run demo:persona            # deploy a fast-clock pet and live with it a while
 *   npm run demo:persona -- 0x…     # continue with a pet already deployed
 *
 * WHAT THIS SHOWS. The LLM does not write the pet's personality — it picks one
 * word out of a closed list the contract owns (`TRAITS`), and the contract moves
 * a counter. The sentence that goes back into the next prompt is rendered from
 * those counters in deterministic code. So this run answers a question that only
 * a real model can answer: *does it actually choose, and does it choose
 * sensibly?* Mocked tests can prove the plumbing; they cannot prove that.
 *
 * WHY THE FAST CLOCK. Character is deliberately slow — one nudge per four
 * in-pet hours, so an owner cannot buy a personality in an afternoon of
 * clicking. `time_scale` compresses that: at 720, one real second is twelve
 * in-pet minutes, so the ~25 s a Bradbury action takes is about five in-pet
 * hours — past the cooldown, and about 10 satiety of hunger. Five actions is a
 * comfortable arc; a real-time pet would take most of a day to do the same.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { buildContract } from "../lib/buildContract.mjs";
import { installGasBuffer } from "../lib/gasBuffer.mjs";
import { waitForSettled, statusName, succeeded, outcome } from "../lib/waitForSettled.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(HERE, "../contracts/ai_pet.py");
const ENV = path.resolve(HERE, "../.env");

// The DEPLOY ARTIFACT, not the source: Bradbury refuses a deploy over ~52 KB and
// contracts/ai_pet.py is past that with its comments. See lib/buildContract.mjs.
const built = buildContract(CONTRACT);
const contractCode = built.code;

const TIME_SCALE = 720;
const CTOR = ["Pixel", "a sleepy philosopher cat who speaks in riddles", "Lisbon", TIME_SCALE];
// A spread of experiences, so a single trait is not the only thing on offer.
const ARC = ["pet", "play", "pet", "check", "play"];

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

let address = process.argv[2];
const read = (fn, args = []) => client.readContract({ address, functionName: fn, args });

async function send(fn, { args = [], value = 0n } = {}) {
  const hash = await client.writeContract({ address, functionName: fn, args, value });
  const tx = await waitForSettled(client, hash, {
    onProgress: (s, ms) =>
      process.stdout.write(`\r    ${fn}() … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
    timeoutMs: 1_200_000,
  });
  if (!succeeded(tx)) throw new Error(`${fn}() did not take effect — ${outcome(tx)}`);
  process.stdout.write(`\r${" ".repeat(60)}\r`);
  await new Promise((r) => setTimeout(r, 4000));
  return tx;
}

function sheet(c) {
  return c.traits
    .map((t) => `${t.name}${"•".repeat(Number(t.level))}`)
    .join("  ");
}

// --------------------------------------------------------------------------- //

if (address) {
  console.log(`continuing with ${address}`);
} else {
  console.log(`\ndeploying a pet on a ${TIME_SCALE}x clock…`);
  const tx = await waitForSettled(
    client,
    await client.deployContract({ code: contractCode, args: CTOR }),
    {
      onProgress: (s, ms) =>
        process.stdout.write(`\r    deploy … ${statusName(s)} ${(ms / 1000).toFixed(0)}s      `),
      timeoutMs: 1_800_000,
    },
  );
  if (!succeeded(tx)) {
    console.error(`\ndeploy did not take effect — ${outcome(tx)}`);
    process.exit(1);
  }
  address = tx.recipient ?? tx.data?.contract_address ?? tx.txDataDecoded?.contractAddress;
  console.log(`\r    deployed ${address}${" ".repeat(20)}`);
}

const start = await read("get_character");
console.log(`\nblank slate: "${(await read("get_state")).character}"`);
console.log(`  ${sheet(start)}`);
console.log(`  one nudge allowed per ${start.cooldown_hours} in-pet hours, ceiling ${start.max_level}\n`);

for (const [i, action] of ARC.entries()) {
  process.stdout.write(`${i + 1}. ${action}() …`);
  await send(action);
  const [s, c] = await Promise.all([read("get_state"), read("get_character")]);
  console.log(`${i + 1}. ${action}()`);
  console.log(`   🐾 "${s.last_quote}"`);
  console.log(`   character: ${s.character ? `"${s.character}"` : "(none yet)"}   ${sheet(c)}`);
  console.log(
    `   satiety ${s.satiety} | mood ${s.mood} | ${s.stage} ${s.age_days}d | evolutions ${c.evolutions}\n`,
  );
  if (Number(s.satiety) < 25) {
    console.log("   (hungry — feeding 0.05 GEN so the arc can continue)");
    await send("feed", { value: 50_000_000_000_000_000n });
  }
}

const end = await read("get_character");
console.log("--- what living made of it ---");
console.log(`  "${end.phrase}"`);
console.log(`  ${sheet(end)}`);
console.log(`  ${end.evolutions} evolution(s), drift ${end.evolving ? "on" : "frozen"}`);
console.log("\n--- lines feed ---");
for (const [i, q] of (await read("get_history")).entries()) console.log(`  ${i + 1}. ${q}`);
console.log(`\nPet address: ${address}`);
