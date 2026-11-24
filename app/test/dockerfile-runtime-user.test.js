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

test("the image makes its own files readable to the runtime user, whatever the checkout's modes (#821 incident)", () => {
  // Measured 2026-11-21: a failing build carried `root:root 770` for the files Docker had cached from
  // an older COPY layer (and 664 for the one file that changed), and the container — running as
  // 1002:10 — crash-looped with `EACCES: permission denied, open '/app/server.js'`. Cached layer modes
  // survive long after the source tree stops producing them, so the image cannot rely on them: one
  // normalization step after COPY is what makes it independent of the build machine.
  const lines = DOCKERFILE.split(/\r?\n/);
  const copyIndex = lines.findIndex((line) => /^COPY\s+\.\s+\.\/?$/.test(line.trim()));
  assert.ok(copyIndex >= 0, "the Dockerfile still copies the source tree with `COPY . ./`");
  const after = lines.slice(copyIndex + 1).filter((line) => line.trim() && !line.trim().startsWith("#"));
  const normalization = after.find((line) => /^RUN\b/.test(line.trim()) && /a\+rX/.test(line));
  assert.ok(normalization, "a RUN line after COPY must relax the modes (a+rX): otherwise a 0770 checkout yields a 0770 image");
  const [uid, gid] = String(compose.services["obsidian-server"].user).split(":");
  assert.match(normalization, new RegExp(`chown -R ${uid}:${gid} /app`), "and it must hand /app to the runtime user");
});
