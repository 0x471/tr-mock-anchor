// Read-only testnet simulation of the public synthetic fixture and three mutations.
// No private passport data, signing secrets, backend attestation, or submitted txs.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    contract: { type: "string" },
    source: { type: "string" },
    "config-dir": { type: "string" },
  },
});
if (!values.contract || !values.source) {
  throw new Error(
    "Required: --contract CONTRACT_ID --source PUBLIC_ACCOUNT_OR_ALIAS [--config-dir PATH]"
  );
}
const fixtureDir = new URL("../fixtures/", import.meta.url);
const original = readFileSync(new URL("proof.bin", fixtureDir));
const inputs = readFileSync(new URL("public_inputs.bin", fixtureDir));
const q =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const base = [
  "contract",
  "invoke",
  "--id",
  values.contract,
  "--source-account",
  values.source,
  "--network",
  "testnet",
  "--send",
  "no",
];
if (values["config-dir"]) base.push("--config-dir", values["config-dir"]);

function check(name, proof, pi, expected) {
  const run = spawnSync(
    "stellar",
    [
      ...base,
      "--",
      "verify",
      "--proof",
      proof.toString("hex"),
      "--public_inputs",
      pi.toString("hex"),
    ],
    { encoding: "utf8", maxBuffer: 2_000_000 }
  );
  if (run.error) throw run.error;
  const accepted = run.status === 0 && run.stdout.trim() === "true";
  const explicitReject =
    run.status !== 0 && /Error\(Contract, #2\)/.test(run.stderr);
  if (expected ? !accepted : !explicitReject) {
    throw new Error(
      `${name}: unexpected result (exit ${run.status}): ${run.stdout}\n${run.stderr}`
    );
  }
  console.log(
    JSON.stringify({
      name,
      accepted,
      result: accepted ? "true" : "InvalidProof (#2)",
      mode: "testnet RPC simulation, not submitted",
      contract: values.contract,
    })
  );
}

console.log(
  "Public synthetic ZKPassport 0.20.0 fixture, dated 2026-07-14; mathematics only, not eligibility."
);
check("valid complete proof", original, inputs, true);
const pi = Buffer.from(inputs);
pi[3 * 32 + 31] ^= 1;
check("changed public scope input", original, pi, false);

const proof = Buffer.from(original);
const y = BigInt(`0x${proof.subarray(-32).toString("hex")}`);
Buffer.from((q - y).toString(16).padStart(64, "0"), "hex").copy(
  proof,
  proof.length - 32
);
check("on-curve negated KZG quotient", proof, inputs, false);

const accumulator = Buffer.from(original);
for (const offset of [0, 128]) {
  const lo = BigInt(
    `0x${accumulator.subarray(offset + 64, offset + 96).toString("hex")}`
  );
  const hi = BigInt(
    `0x${accumulator.subarray(offset + 96, offset + 128).toString("hex")}`
  );
  const negated = q - (lo + (hi << 136n));
  Buffer.from(
    (negated & ((1n << 136n) - 1n)).toString(16).padStart(64, "0"),
    "hex"
  ).copy(accumulator, offset + 64);
  Buffer.from((negated >> 136n).toString(16).padStart(64, "0"), "hex").copy(
    accumulator,
    offset + 96
  );
}
check(
  "both accumulator points negated: outer binding rejects",
  accumulator,
  inputs,
  false
);
