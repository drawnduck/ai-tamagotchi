/**
 * The sha256 the directory's allowlist wants — of a build artifact, or of the
 * code actually deployed at an address.
 *
 *   node tools/fingerprint.mjs build/ai_pet.py      # a file: hash what we ship
 *   node tools/fingerprint.mjs 0xPET [--net testnet_bradbury]
 *                                                   # an address: hash what the
 *                                                   #   network says is there
 *
 * The two agreeing is the whole scheme: `AiPetFactory.register` fetches the
 * deployed code through the same RPC (`gen_getContractCode`) inside strict_eq,
 * hashes it the same way, and admits only hashes the admin allowlisted with
 * `add_fingerprint`. Anyone can re-run this to audit what a fingerprint means.
 */
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { createClient } from "genlayer-js";
import { testnetBradbury, studionet, localnet } from "genlayer-js/chains";

const NETS = { testnet_bradbury: testnetBradbury, studionet, localnet };
const args = process.argv.slice(2);
const target = args[0];
const net = NETS[args[args.indexOf("--net") + 1]] ?? testnetBradbury;

if (!target) {
  console.error("usage: node tools/fingerprint.mjs <file-or-address> [--net testnet_bradbury]");
  process.exit(1);
}

let code;
if (/^0x[0-9a-fA-F]{40}$/.test(target)) {
  const client = createClient({ chain: net });
  const b64 = await client.request({
    method: "gen_getContractCode",
    params: net.isStudio ? [target] : [{ address: target }],
  });
  code = Buffer.from(b64, "base64");
  console.error(`deployed code at ${target} on ${net.name ?? "testnet"}: ${code.length} bytes`);
} else if (existsSync(target)) {
  code = readFileSync(target);
  console.error(`${target}: ${code.length} bytes`);
} else {
  console.error(`${target} is neither an address nor a file`);
  process.exit(1);
}

console.log(createHash("sha256").update(code).digest("hex"));
