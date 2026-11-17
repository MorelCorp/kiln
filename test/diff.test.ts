import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCollapsed, diffTotals, fileKey, isGenerated, parseDiff, splitRows, LARGE_FILE_LINES, PAGE_LINE_BUDGET } from "../web/src/diff.ts";

const MULTI = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function main() {
 import a from "a";
-const x = 1;
+const x = 2;
+const y = 3;

 run();
@@ -20,3 +21,2 @@ function tail() {
 one
-two
 three
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Webapp
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

test("parseDiff splits multi-file, multi-hunk diffs with line numbers", () => {
  const files = parseDiff(MULTI);
  assert.equal(files.length, 3);
  const [app, readme, old] = files;

  assert.equal(app.path, "src/app.ts");
  assert.equal(app.status, "modified");
  assert.equal(app.hunks.length, 2);
  assert.equal(app.additions, 2);
  assert.equal(app.deletions, 2);
  const h = app.hunks[0];
  assert.equal(h.section, "export function main() {");
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [1, 4, 1, 5]);
  assert.deepEqual(h.lines.map((l) => [l.kind, l.old, l.new]), [
    ["ctx", 1, 1], ["del", 2, undefined], ["add", undefined, 2], ["add", undefined, 3], ["ctx", 3, 4], ["ctx", 4, 5],
  ]);
  assert.equal(h.lines[3].text, "const y = 3;");
  assert.equal(h.lines[4].text, "", "an empty context line keeps its place");
  assert.deepEqual(app.hunks[1].lines.map((l) => [l.kind, l.old, l.new]), [["ctx", 20, 21], ["del", 21, undefined], ["ctx", 22, 22]]);

  assert.equal(readme.status, "added");
  assert.equal(readme.path, "README.md");
  assert.equal(readme.additions, 2);
  assert.deepEqual(readme.hunks[0].lines.map((l) => l.new), [1, 2]);

  assert.equal(old.status, "deleted");
  assert.equal(old.path, "old.txt");
  assert.equal(old.deletions, 1);

  assert.deepEqual(diffTotals(files), { files: 3, additions: 4, deletions: 3 });
});

test("parseDiff handles renames with and without content changes", () => {
  const files = parseDiff(`diff --git a/src/a.ts b/src/b.ts
similarity index 100%
rename from src/a.ts
rename to src/b.ts
diff --git a/lib/x y.ts b/lib/z.ts
similarity index 90%
rename from lib/x y.ts
rename to lib/z.ts
index 1..2 100644
--- a/lib/x y.ts
+++ b/lib/z.ts
@@ -1,2 +1,2 @@
 keep
-old
+new
`);
  assert.equal(files.length, 2);
  assert.equal(files[0].status, "renamed");
  assert.equal(files[0].oldPath, "src/a.ts");
  assert.equal(files[0].newPath, "src/b.ts");
  assert.equal(files[0].path, "src/b.ts");
  assert.equal(files[0].similarity, 100);
  assert.equal(files[0].hunks.length, 0);
  assert.equal(files[1].status, "renamed");
  assert.equal(files[1].oldPath, "lib/x y.ts");
  assert.equal(files[1].newPath, "lib/z.ts");
  assert.equal(files[1].additions, 1);
  assert.equal(files[1].deletions, 1);
});

test("parseDiff marks binary files", () => {
  const files = parseDiff(`diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/img/logo.png differ
diff --git a/img/icon.png b/img/icon.png
index 6666666..7777777 100644
GIT binary patch
literal 10
Rcmb=e

literal 0
HcmV?d00001

`);
  assert.equal(files.length, 2);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].status, "added");
  assert.equal(files[0].path, "img/logo.png");
  assert.equal(files[0].hunks.length, 0);
  assert.equal(files[1].binary, true);
  assert.equal(files[1].status, "modified");
});

test("parseDiff flags missing newline at end of file", () => {
  const files = parseDiff(`diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 first
-last
\\ No newline at end of file
+last
\\ No newline at end of file
diff --git a/b.txt b/b.txt
index 3..4 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-x
+y
`);
  assert.equal(files.length, 2);
  const lines = files[0].hunks[0].lines;
  assert.deepEqual(lines.map((l) => [l.kind, !!l.noNewline]), [["ctx", false], ["del", true], ["add", true]]);
  assert.equal(files[1].additions, 1);
  assert.equal(files[1].hunks[0].lines[1].noNewline, undefined);
});

test("parseDiff: empty input, mode changes, quoted paths and plain unified diffs", () => {
  assert.deepEqual(parseDiff(""), []);
  const mode = parseDiff(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`);
  assert.equal(mode[0].status, "modified");
  assert.equal(mode[0].oldMode, "100644");
  assert.equal(mode[0].newMode, "100755");

  const quoted = parseDiff(`diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
new file mode 100644
--- /dev/null
+++ "b/caf\\303\\251.txt"
@@ -0,0 +1 @@
+hi
`);
  assert.equal(quoted[0].path, "café.txt");

  const plain = parseDiff(`--- a/one.txt\t2026-01-01
+++ b/one.txt\t2026-01-02
@@ -1 +1 @@
-a
+b
--- a/two.txt
+++ b/two.txt
@@ -1 +1,2 @@
 a
+b
`);
  assert.deepEqual(plain.map((f) => [f.path, f.additions, f.deletions]), [["one.txt", 1, 1], ["two.txt", 1, 0]]);
});

test("parseDiff keeps --- and +++ content lines inside a hunk", () => {
  const files = parseDiff(`diff --git a/doc.md b/doc.md
index 1..2 100644
--- a/doc.md
+++ b/doc.md
@@ -1,2 +1,2 @@
--- a rule
-++ old
+++ new
 end
`);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].hunks[0].lines.map((l) => [l.kind, l.text]), [["del", "-- a rule"], ["del", "++ old"], ["add", "++ new"], ["ctx", "end"]]);
});

test("splitRows pairs deletions with the additions that follow", () => {
  const [f] = parseDiff(`diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,4 +1,4 @@
 c
-d1
-d2
+a1
 c2
+a2
`);
  const rows = splitRows(f.hunks[0].lines);
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    ["c", "c"], ["d1", "a1"], ["d2", null], ["c2", "c2"], [null, "a2"],
  ]);
});

test("generated and large files start collapsed", () => {
  assert.equal(isGenerated("package-lock.json"), true);
  assert.equal(isGenerated("web/dist/index.js"), true);
  assert.equal(isGenerated("assets/app.min.js"), true);
  assert.equal(isGenerated("src/app.ts"), false);

  const body = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n");
  const file = (p: string, n: number) => `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${n} @@\n${body(n)}\n`;
  const files = parseDiff(file("src/small.ts", 10) + file("yarn.lock", 5) + file("src/big.ts", LARGE_FILE_LINES + 1) + file("src/a.ts", 300) + file("src/b.ts", PAGE_LINE_BUDGET));
  assert.equal(files.length, 5);
  assert.equal(files[2].additions, LARGE_FILE_LINES + 1);
  const c = defaultCollapsed(files);
  assert.deepEqual(files.map((f) => c.has(fileKey(f))), [false, true, true, false, true]);

  // Past the page budget, even ordinary files start collapsed.
  const many = parseDiff(Array.from({ length: 10 }, (_, i) => file(`src/f${i}.ts`, 350)).join(""));
  const per = Math.floor(PAGE_LINE_BUDGET / 350);
  assert.deepEqual(many.map((f) => defaultCollapsed(many).has(fileKey(f))), many.map((_, i) => i >= per));
});
