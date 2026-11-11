// The container runs as `user: "1002:10"` (docker-compose.yaml), and the alpine base image has no
// record for that uid. `ssh` refuses to run without one, so `git push` over SSH fails inside the
// container with "No user exists for uid 1002". The Dockerfile must add the record, and its uid and
// gid must stay equal to the compose `user:` value.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = readFileSync(path.join(APP_ROOT, "Dockerfile"), "utf8");
const compose = yaml.load(readFileSync(path.join(APP_ROOT, "..", "docker-compose.yaml"), "utf8"));

const passwdLine = DOCKERFILE.split(/\r?\n/).find((line) => />>\s*\/etc\/passwd/.test(line)) ?? "";

test("the image gives the runtime uid a passwd record", () => {
  assert.match(passwdLine, /echo\s+"app:x:1002:10:app:\/data:\/bin\/sh"/);
});

test("that record matches the compose user", () => {
  const [uid, gid] = String(compose.services["obsidian-server"].user).split(":");
  const fields = passwdLine.match(/"([^"]+)"/)?.[1].split(":") ?? [];
  assert.equal(fields[2], uid, "the passwd uid must equal the compose uid");
  assert.equal(fields[3], gid, "the passwd gid must equal the compose gid");
});
