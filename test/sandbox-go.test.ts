import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kiln-go-"));
process.env.KILN_HOME = join(root, "home");
process.env.KILN_STATE = join(root, "state");
const { projectSandbox } = await import("../src/factory/gate.ts");

test("sandbox.go adds a writable cache mount and Go env", () => {
  const dir = join(root, "gocache");
  const s = projectSandbox({ mounts: [], env: {}, go: true }, dir);
  assert.deepEqual(s.mounts, [{ path: dir, readonly: false }]);
  assert.equal(s.env.GOPATH, dir);
  assert.equal(s.env.GOMODCACHE, join(dir, "mod"));
  assert.equal(s.env.GOCACHE, join(dir, "build"));
  assert.equal(s.env.GOTOOLCHAIN, "local");
});

test("without sandbox.go nothing is added, and project env wins when it is", () => {
  assert.deepEqual(projectSandbox({ mounts: [], env: { A: "1" }, go: false }), { mounts: [], env: { A: "1" } });
  const s = projectSandbox({ mounts: [], env: { GOTOOLCHAIN: "auto" }, go: true }, join(root, "g2"));
  assert.equal(s.env.GOTOOLCHAIN, "auto");
});
