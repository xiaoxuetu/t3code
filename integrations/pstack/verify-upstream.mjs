import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("./UPSTREAM.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
assert.equal(manifest.repository, "https://github.com/cursor/plugins");
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.license, "MIT");
assert.equal(manifest.copyright, "Copyright (c) 2026 Lauren Tan");
const expectedPaths = [
  "pstack/LICENSE",
  "pstack/skills/swarm/SKILL.md",
  "pstack/skills/poteto-mode/playbooks/orchestrate.md",
];
assert.deepEqual(manifest.files.map((file) => file.upstreamPath), expectedPaths);
for (const file of manifest.files) {
  const expectedLocalPath = `upstream/${file.upstreamPath.slice("pstack/".length)}`;
  assert.equal(file.localPath, expectedLocalPath);
  assert.equal(
    file.url,
    `https://raw.githubusercontent.com/cursor/plugins/${manifest.commit}/${file.upstreamPath}`,
  );
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  const bytes = await readFile(new URL(file.localPath, manifestUrl));
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, file.sha256, `${file.localPath}: vendored source changed`);
  console.log(`PASS ${file.localPath} ${actual}`);
}
