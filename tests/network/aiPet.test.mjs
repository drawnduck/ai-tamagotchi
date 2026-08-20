/**
 * Network tests for AiPet — the coverage direct mode structurally cannot provide.
 *
 *   npm run test:network                       # deploy a fresh pet and drive it
 *   PET_ADDRESS=0x… npm run test:network       # reuse a deployed pet (much cheaper)
 *   SETTLE=1 npm run test:network              # also wait out the withdraw payout (~30 min)
 *   RECEIVE=1 npm run test:network             # also test __receive__ (deploys a 2nd contract)
 *   PEER_ADDRESS=0x… npm run test:network      # also test visiting that pet (must be FINALIZED)
 *   NETWORK=localnet npm run test:network      # against a local node instead
 *
 * WHY THIS EXISTS
 * ---------------
 * `tests/direct/` runs the contract in the real GenVM but stubs the host, and every
 * outgoing transfer there is a silent no-op — `PostMessage` and `EthSend` both fall
 * through to "unknown gl_call request type". That blind spot hid a real bug: for a
 * while `withdraw()` could not pay a wallet at all on a live network while 27 direct
 * tests reported success. Anything that moves value has to be asserted here.
 *
 * It replaces `tests/integration/test_ai_pet.py`, which cannot run at all: `gltest`
 * needs the RPC method `gen_getContractSchemaForCode`, and Bradbury answers
 * `method not found`. See ROADMAP §3b.
 *
 * COST AND ORDER
 * --------------
 * These spend real GEN and real minutes, so — unlike the direct suite — the tests
 * share ONE pet and run in a deliberate order. Guards that only need to prove a
 * revert use `simulateWriteContract`, which runs the same GenVM code without
 * consensus and costs nothing.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { buildContract } from "../../lib/buildContract.mjs";
import { installGasBuffer } from "../../lib/gasBuffer.mjs";
import { waitForSettled, succeeded, outcome } from "../../lib/waitForSettled.mjs";
import { revertReason } from "../../lib/revertReason.mjs";
import { simulateEvents } from "../../lib/readEvents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(HERE, "../../contracts/ai_pet.py");
const ENV = path.resolve(HERE, "../../.env");

// The DEPLOY ARTIFACT, not the source: Bradbury refuses a deploy over ~52 KB and
// contracts/ai_pet.py is past that with its comments. See lib/buildContract.mjs.
const built = buildContract(CONTRACT);
const contractCode = built.code;

const CTOR = ["Pixel", "a sleepy philosopher cat who speaks in riddles", "Lisbon"];
const FEED_WEI = 50_000_000_000_000_000n; // 0.05 GEN => +5 satiety
const CHAIN = chains[process.env.NETWORK ?? "testnetBradbury"];

// keccak256("PetSpoke(action,actor)") — the topic clients subscribe by. Indexed
// field names are sorted alphabetically by the SDK before the signature is built.
const PET_SPOKE_TOPIC = "0xca2acee260a2d931a04a1ea28a2b7bcedfe75e31f1310d09ae7df297ce406fc7";

// A real check() spends 40-60 s on the web request plus the LLM, and Bradbury has
// been seen stalling for far longer than that (ROADMAP §3b). Failing early would
// report a live transaction as broken.
const SETTLE_MS = 1_800_000;

let client;
let owner;
let address;

function privateKey() {
  const m = readFileSync(ENV, "utf8").match(
    /^\s*[A-Z_0-9]*PRIVATE_KEY[A-Z_0-9]*\s*=\s*(0x[0-9a-fA-F]{64})/m,
  );
  if (!m) throw new Error(`no PRIVATE_KEY=0x… in ${ENV} — use a throwaway testnet key`);
  return m[1];
}

const read = (fn, args = []) => client.readContract({ address, functionName: fn, args });

/** Send a write and fail loudly unless consensus accepted it. Returns the tx. */
async function send(fn, { args = [], value = 0n } = {}) {
  const hash = await client.writeContract({ address, functionName: fn, args, value });
  const tx = await waitForSettled(client, hash, { timeoutMs: SETTLE_MS });
  // Not just the status: a transaction can finalize with vote IDLE and change
  // nothing at all while still reporting FINISHED_WITH_RETURN. See succeeded().
  assert.ok(succeeded(tx), `${fn}() did not take effect — ${outcome(tx)}`);
  // ACCEPTED is the consensus verdict; the node's readable state trails it a beat.
  await new Promise((r) => setTimeout(r, 4000));
  return tx;
}

before(async () => {
  installGasBuffer();
  owner = createAccount(privateKey());
  client = createClient({ chain: CHAIN, account: owner });

  if (process.env.PET_ADDRESS) {
    address = process.env.PET_ADDRESS;
    console.log(`reusing pet ${address} on ${CHAIN.name}`);
    return;
  }
  console.log(`deploying a fresh pet to ${CHAIN.name}…`);
  const hash = await client.deployContract({
    code: contractCode,
    args: CTOR,
  });
  const tx = await waitForSettled(client, hash, { timeoutMs: SETTLE_MS });
  assert.ok(succeeded(tx), `deploy did not take effect — ${outcome(tx)}`);
  address = tx.recipient;
  assert.ok(address, "deploy produced no contract address");
  console.log(`deployed ${address}`);
});

// --------------------------------------------------------------------------- //
// Free assertions: no gas, no consensus — just the contract's own logic.
// --------------------------------------------------------------------------- //

test("a fresh pet is alive, unfed and still an egg", async () => {
  const s = await read("get_state");
  assert.equal(s.alive, true);
  assert.equal(s.stage, "egg");
  assert.equal(Number(s.revives), 0);
  assert.equal(Number(s.health), 100);
  assert.equal(String(s.total_fed_wei), "0");
  assert.equal(Number(s.time_scale), 1, "a test pet must run on real time");
});

test("the deployer owns the pet", async () => {
  assert.equal(
    String(await read("get_owner")).toLowerCase(),
    owner.address.toLowerCase(),
  );
});

/** Run a write in simulation and return the revert reason. Throws if it succeeds. */
async function expectRevert(args) {
  try {
    await client.simulateWriteContract({ address, ...args });
  } catch (err) {
    return revertReason(err);
  }
  assert.fail(`${args.functionName}() was expected to revert but went through`);
}

test("reviving a living pet is refused", async () => {
  const cost = BigInt((await read("get_state")).revive_cost_wei);
  const reason = await expectRevert({ functionName: "revive", args: [], value: cost });
  assert.match(reason, /alive/i, `unexpected revert reason: ${reason}`);
});

test("a pet refuses to visit itself", async () => {
  const reason = await expectRevert({ functionName: "visit", args: [address] });
  assert.match(reason, /itself/i, `unexpected revert reason: ${reason}`);
});

// Two layers refuse a stranger, and only a live node shows which is which:
//
//   * an address with no code at all never reaches the contract's own check —
//     GenVM aborts the caller with `invalid_contract absent_runner_comment`
//     while trying to start the sub-VM. Measured here; the direct-mode double
//     cannot show it, because it answers for any address it is asked about.
//   * a contract that exists but does not answer `get_state()` like a pet is
//     caught by _neighbour_state and gets the contract's own message.
//
// Both end in a refusal, which is what matters. The message differs.
const NOT_A_PET = /AiPet|invalid_contract/i;

test("a pet refuses to visit something that is not a pet", async () => {
  const reason = await expectRevert({
    functionName: "visit",
    args: [createAccount(generatePrivateKey()).address],
  });
  assert.match(reason, NOT_A_PET, `unexpected revert reason: ${reason}`);
});

test("a wallet cannot greet a pet", async () => {
  // receive_visit is a contract-to-contract door. An EOA reaches it — nothing
  // stops anyone calling a public method — and is turned away by the same read.
  const reason = await expectRevert({
    account: createAccount(generatePrivateKey()),
    functionName: "receive_visit",
    args: ["hello, I am definitely a pet"],
  });
  assert.match(reason, NOT_A_PET, `unexpected revert reason: ${reason}`);
});

test("a stranger cannot change the persona", async () => {
  const reason = await expectRevert({
    account: createAccount(generatePrivateKey()),
    functionName: "set_persona",
    args: ["a hostile takeover"],
  });
  assert.match(reason, /owner/i, `unexpected revert reason: ${reason}`);
});

// --------------------------------------------------------------------------- //
// Real consensus, real money.
// --------------------------------------------------------------------------- //

test("every action emits a PetSpoke carrying the state it reports", async () => {
  // Events are invisible everywhere else: direct mode no-ops emit(), the tx object
  // has no events field, and they never reach EVM logs (verified over 2000 blocks
  // after a FINALIZED/AGREE transaction). The raw gen_call result is the only
  // place they exist — see lib/readEvents.mjs.
  const events = await simulateEvents(client, { address, functionName: "pet" });
  assert.equal(events.length, 1, "pet() should emit exactly one event");

  const [event] = events;
  assert.equal(event.topic, PET_SPOKE_TOPIC, "PetSpoke signature changed — clients subscribe by this");
  assert.equal(event.indexed.length, 2, "action and actor are the indexed fields");

  const { blob } = event;
  assert.equal(blob.action, "pet");
  assert.equal(blob.actor.toLowerCase(), owner.address.toLowerCase());
  assert.ok(blob.quote.length > 0, "the event should carry the line the pet just said");

  // The event must agree with the state it claims to describe.
  const s = await read("get_state");
  for (const field of ["satiety", "health", "stage", "age_days"]) {
    assert.equal(String(blob[field]), String(s[field]), `${field} disagrees with get_state()`);
  }
});

test("check() reads the live web, calls the LLM, and speaks", async () => {
  const before = (await read("get_history")).length;
  await send("check");
  const s = await read("get_state");
  assert.ok(s.last_quote.length > 0, "the pet said nothing");
  assert.equal((await read("get_history")).length, before + 1);
});

// An egg cannot play (STAGE_MIN_PLAY == "hatchling"), and the pet this suite
// deploys is a fresh one — see "a fresh pet is alive, unfed and still an egg"
// above. Which branch runs therefore depends on how old the deployed pet is by
// the time the suite reaches here, so both are asserted rather than one skipped.
// This is also the half of test_play_on_egg_reverts_before_it_speaks that direct
// mode cannot prove: GenVM rolls the whole transaction back, so the decay the
// refused call had already billed goes back with it and satiety does not move.
test("play() burns satiety, unless the pet is still an egg", async () => {
  const s = await read("get_state");
  const before = Number(s.satiety);

  if (s.stage === "egg") {
    await assert.rejects(send("play"), /too young/, "an egg must not be able to play");
    assert.equal(
      Number((await read("get_state")).satiety),
      before,
      "a refused play must not bill the idle time it just walked",
    );
    return;
  }

  await send("play");
  assert.ok(
    Number((await read("get_state")).satiety) < before,
    "playing should cost satiety",
  );
});

test("feed() moves real GEN into the contract and credits the feeder", async () => {
  const heldBefore = await client.getBalance({ address });
  const fedBefore = BigInt((await read("get_state")).total_fed_wei);

  await send("feed", { value: FEED_WEI });

  assert.equal(
    (await client.getBalance({ address })) - heldBefore,
    FEED_WEI,
    "the contract balance should grow by exactly what was sent",
  );
  assert.equal(
    BigInt((await read("get_state")).total_fed_wei) - fedBefore,
    FEED_WEI,
    "total_fed should record the same amount",
  );

  const board = await read("get_top_feeders", [0]);
  const mine = board.find((f) => f.address.toLowerCase() === owner.address.toLowerCase());
  assert.ok(mine, "the feeder is missing from the leaderboard");
  assert.ok(BigInt(mine.wei) >= FEED_WEI, "the leaderboard credited too little");
});

test("the till keeps a 1 GEN revive reserve", async () => {
  // The guard, asserted whatever the funding level is. Anything above the
  // reserve is the owner's; the reserve itself never is, once the pet's lifetime
  // food has reached a whole revive. A till that has never taken in that much
  // has promised nobody a revive — and could not perform one if it wanted to,
  // since the same threshold gates till_revive_ready — so it keeps nothing back.
  const s = await read("get_state");
  const held = await client.getBalance({ address });
  const withdrawable = BigInt(s.withdrawable_wei ?? held.toString());
  const fed = BigInt(s.total_fed_wei);
  const reserve = BigInt(s.revive_cost_wei);

  if (fed < reserve) {
    assert.equal(withdrawable, held, "a pet fed less than one revive reserves nothing");
    return;
  }
  assert.equal(
    withdrawable,
    held > reserve ? held - reserve : 0n,
    "withdrawable should be the balance less the reserve",
  );
  if (held > 0n) {
    await assert.rejects(
      send("withdraw", { args: [held] }),
      /revive reserve/,
      "the owner must not be able to take the reserve",
    );
  }
});

test("withdraw() emits a plain value transfer, not a method call", async (t) => {
  // THE REGRESSION THIS FILE EXISTS FOR.
  //
  // `gl.get_contract_at(owner).emit_transfer(...)` posts a __receive__ *call*
  // (messageType 1, calldata 0xc20680). A wallet has no code to run it, so
  // consensus silently declines to issue the message and the owner is never paid,
  // while the transaction still reports FINISHED_WITH_RETURN. The fix routes
  // through gl.evm.contract_interface, which posts an EthSend with EMPTY calldata.
  //
  // Asserting the message shape catches that in seconds; asserting the balance
  // takes half an hour of finality (see the next test).
  const held = await client.getBalance({ address });
  assert.ok(held > 0n, "nothing to withdraw — did feed() run?");

  // Once the pet's LIFETIME food reaches REVIVE_COST, one GEN stays behind as
  // the next revive, so the owner may only take withdrawable_wei — which at this
  // suite's funding level (FEED_WEI is 0.05 GEN against a 1 GEN threshold) is
  // usually the whole balance, because the reserve has not switched on yet. The
  // contract publishes the number precisely so a client never has to work it out.
  const st = await read("get_state");
  const withdrawable = BigInt(st.withdrawable_wei ?? held.toString());
  if (withdrawable === 0n) {
    t.skip("the revive reserve holds the whole balance — nothing to withdraw");
    return;
  }

  const tx = await send("withdraw", { args: [withdrawable] });
  const messages = tx.messages ?? [];
  assert.equal(messages.length, 1, "withdraw() should emit exactly one message");

  const [msg] = messages;
  assert.equal(Number(msg.messageType), 0, "must be a plain transfer, not a contract call");
  assert.equal(msg.data, "0x", "a wallet cannot execute calldata — it must be empty");
  assert.equal(msg.recipient.toLowerCase(), owner.address.toLowerCase());
  // `withdrawable`, NOT `held`. The two are equal only when no reserve applies,
  // and the skip above means this line is reached only when one DOES: the
  // assertion could never have been true where it could be reached. It was
  // dormant purely because FEED_WEI is small enough that withdrawable is zero on
  // a fresh deploy, so it would have fired the first time anyone ran the suite
  // against a well-fed PET_ADDRESS — the documented cheap path at the top.
  assert.equal(BigInt(msg.value), withdrawable);

  process.env.WITHDRAW_TX = tx.txId ?? "";
});

test("withdraw() actually pays the owner", { skip: !process.env.SETTLE }, async (t) => {
  // Opt-in: the payout is dispatched by consensus at FINALIZED, which took ~30 min
  // on Bradbury. Run with SETTLE=1 when you want the whole thing proven end to end.
  const hash = process.env.WITHDRAW_TX;
  if (!hash) {
    t.skip("no withdraw transaction to watch — the reserve held the whole balance");
    return;
  }

  // NOT `balance === 0n` any more, and not `balance` at all. Two reasons:
  // once the pet has been fed, REVIVE_COST stays behind for good, so the
  // contract can never reach zero; and under correction C3 a till-revive does
  // not send its GEN anywhere — burned_wei rises and the on-chain balance does
  // not move. What settles is the owner's payout, and what proves it settled is
  // withdrawable_wei falling to zero.
  const started = Date.now();
  for (;;) {
    const s = await read("get_state");
    if (BigInt(s.withdrawable_wei) === 0n) break;
    assert.ok(Date.now() - started < SETTLE_MS,
      `contract still owes the owner ${s.withdrawable_wei} wei`);
    await new Promise((r) => setTimeout(r, 30_000));
  }

  const s = await read("get_state");
  assert.equal(BigInt(s.withdrawable_wei), 0n);
  if (BigInt(s.total_fed_wei) > 0n) {
    assert.ok(
      (await client.getBalance({ address })) >= BigInt(s.revive_cost_wei),
      "the revive reserve should still be sitting on the contract, not zero",
    );
  }
});

test("visit() posts the greeting as a call to the host", { skip: !process.env.PEER_ADDRESS }, async () => {
  // The counterpart of the withdraw() message-shape test, and it matters for the
  // same reason: `PostMessage` is a silent no-op in direct mode, so the only place
  // the greeting's wire shape can be checked is a live node. The two message kinds
  // are opposites — withdraw() must produce an EthSend with EMPTY calldata (a
  // wallet cannot execute a call), a visit must produce a CALL (a contract must).
  const peer = process.env.PEER_ADDRESS;
  const before = await client.readContract({
    address: peer, functionName: "get_social", args: [],
  });

  const tx = await send("visit", { args: [peer] });
  const messages = tx.messages ?? [];
  assert.equal(messages.length, 1, "visit() should emit exactly one message");

  const [msg] = messages;
  assert.equal(Number(msg.messageType), 1, "a greeting must be a contract call, not a transfer");
  assert.equal(msg.recipient.toLowerCase(), peer.toLowerCase());
  assert.equal(BigInt(msg.value), 0n, "a visit sends words, not money");
  assert.notEqual(msg.data, "0x", "an empty calldata would be a bare transfer");

  const said = (await read("get_state")).last_quote;
  assert.ok(said.length > 0, "the visitor said nothing");

  // And it must arrive: the host executes receive_visit in its own transaction,
  // dispatched by consensus once this one is accepted.
  const deadline = Date.now() + 900_000;
  let after = before;
  while (Number(after.visits_received) === Number(before.visits_received)) {
    assert.ok(Date.now() < deadline, "the greeting was never delivered to the host");
    await new Promise((r) => setTimeout(r, 10_000));
    after = await client.readContract({ address: peer, functionName: "get_social", args: [] });
  }

  // Mirrors contracts/ai_pet.py::_sanitize — the host stores a guest's words the
  // way it would store any foreign text, fence characters replaced and truncated.
  const sanitized = said.slice(0, 160).replace(/[[\]{}<>\n\r\t]/g, " ").trim();
  assert.equal(after.pending_quote, sanitized, "the host stored a different line than the guest said");
  assert.equal(
    after.pending_from.toLowerCase(),
    address.toLowerCase(),
    "the host recorded the wrong guest",
  );

  // The three keys above are the HEAD of a FIFO queue now, not a single slot.
  // A peer that has been greeted once holds exactly one guest, and the head
  // must agree with the queue — if these ever disagree, the compatibility shim
  // in get_social() is publishing something the queue does not contain.
  assert.equal(Number(after.greeting_queue_max), 3, "GREETING_QUEUE_MAX changed");
  assert.equal(Number(after.pending_count), 1, "one greeting, one queued guest");
  assert.equal(after.pending[0].quote, after.pending_quote);
  assert.equal(after.pending[0].from.toLowerCase(), after.pending_from.toLowerCase());
});

test("a bare transfer reaches __receive__ and is credited", { skip: !process.env.RECEIVE }, async () => {
  // Opt-in: triggering __receive__ needs a *contract* to send from, so this
  // deploys and funds a second contract — roughly doubling the suite's cost. The
  // handler's own logic is covered by six direct tests; what this checks is the
  // network routing, which only a node upgrade would change.
  const vault = await (async () => {
    const tx = await waitForSettled(
      client,
      await client.deployContract({
        code: new Uint8Array(readFileSync(path.resolve(HERE, "../../tools/transferProbe.py"))),
        args: [],
      }),
      { timeoutMs: SETTLE_MS },
    );
    assert.ok(succeeded(tx), `vault deploy did not take effect — ${outcome(tx)}`);
    return tx.recipient;
  })();

  const fedBefore = BigInt((await read("get_state")).total_fed_wei);
  const satietyBefore = Number((await read("get_state")).satiety);

  const sendFrom = async (fn, args, value = 0n) => {
    const tx = await waitForSettled(
      client,
      await client.writeContract({ address: vault, functionName: fn, args, value }),
      { timeoutMs: SETTLE_MS },
    );
    assert.ok(succeeded(tx), `vault.${fn}() did not take effect — ${outcome(tx)}`);
  };

  await sendFrom("fund", [], 2n * FEED_WEI);
  await sendFrom("pay_to", [address, FEED_WEI]);

  // The value lands at the EVM level first; the __receive__ execution is a
  // separate GenVM transaction that arrives a few seconds later. Observed live:
  // balance had moved while total_fed was still 0. Give it room.
  let fedAfter = fedBefore;
  for (let i = 0; i < 12 && fedAfter === fedBefore; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    fedAfter = BigInt((await read("get_state")).total_fed_wei);
  }

  assert.equal(fedAfter - fedBefore, FEED_WEI, "a bare transfer should be booked as food");
  assert.ok(
    Number((await read("get_state")).satiety) > satietyBefore,
    "a bare transfer should raise satiety",
  );
  const board = await read("get_top_feeders", [0]);
  assert.ok(
    board.some((f) => f.address.toLowerCase() === vault.toLowerCase()),
    "the sending contract should appear on the leaderboard",
  );
});
