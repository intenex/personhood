import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decrypt, encrypt, validateName, Vault } from "./vault.ts";
import { tmp } from "./test/helpers.ts";

const key = crypto.randomBytes(32);

test("encrypt/decrypt round trip, and ciphertext reveals nothing", () => {
  const blob = encrypt("a secret thought about Ben", key);
  assert.ok(!blob.includes("secret"));
  assert.equal(decrypt(blob, key), "a secret thought about Ben");
});

test("tampering and wrong keys are detected", () => {
  const blob = encrypt("hello", key);
  const [magic, payload] = blob.split("\n");
  const buf = Buffer.from(payload, "base64");
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decrypt(`${magic}\n${buf.toString("base64")}\n`, key));
  assert.throws(() => decrypt(blob, crypto.randomBytes(32)));
});

test("private names are validated and can't escape the vault", () => {
  assert.equal(validateName("journal/2026-10-11"), "journal/2026-10-11");
  for (const bad of ["../etc/passwd", "journal/../../x", "/abs", "UPPER case", ""]) {
    if (bad === "/abs") assert.equal(validateName(bad), "abs");
    else assert.throws(() => validateName(bad), bad);
  }
});

test("vault write, append, list, search", () => {
  const mind = tmp();
  const v = new Vault(mind, key);
  v.write("journal/day-one", "first line");
  v.append("journal/day-one", "second line about moss");
  assert.equal(v.read("journal/day-one"), "first line\nsecond line about moss");
  assert.deepEqual(v.list().map((f) => f.name), ["journal/day-one"]);
  assert.equal(v.search("moss")[0].line, 2);
  const onDisk = fs.readFileSync(path.join(mind, "private", "journal", "day-one.enc"), "utf8");
  assert.ok(!onDisk.includes("moss"));
});
