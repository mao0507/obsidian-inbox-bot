import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFolder, INBOX_FALLBACK } from "../src/taxonomy.js";
import { createTagVocabulary, tagKey } from "../src/tagVocabulary.js";
import { createNoteStore } from "../src/noteStore.js";

test("buildFolder: 大/中/主tag for fixed 中項目", () => {
  assert.equal(buildFolder({ category: "技術", subcategory: "前端框架", primaryTag: "Vue" }), "技術/前端框架/Vue");
  assert.equal(buildFolder({ category: "AI", subcategory: "編程助手", primaryTag: "ClaudeCode" }), "AI/編程助手/ClaudeCode");
});

test("buildFolder: 旅遊 and 專案 accept any 中項目 (country / project name)", () => {
  assert.equal(buildFolder({ category: "旅遊", subcategory: "日本", primaryTag: "北海道" }), "旅遊/日本/北海道");
  assert.equal(buildFolder({ category: "專案", subcategory: "Lunch-System", primaryTag: "API" }), "專案/Lunch-System/API");
});

test("buildFolder: 收件匣 has no tag level", () => {
  assert.equal(buildFolder({ category: "收件匣", subcategory: "靈感", primaryTag: "隨便" }), "收件匣/靈感");
});

test("buildFolder: unknown 大/中項目 or missing tag returns null", () => {
  assert.equal(buildFolder({ category: "知識庫", subcategory: "Vue", primaryTag: "Vue" }), null);
  assert.equal(buildFolder({ category: "技術", subcategory: "亂寫", primaryTag: "Vue" }), null);
  assert.equal(buildFolder({ category: "技術", subcategory: "前端框架", primaryTag: "" }), null);
  assert.equal(buildFolder({ category: "旅遊", subcategory: "a/b", primaryTag: "x" }), null, "no path injection");
  assert.equal(INBOX_FALLBACK, "收件匣/待整理");
});

test("tagKey ignores case, spaces and separators", () => {
  assert.equal(tagKey("Claude Code"), tagKey("claude-code"));
  assert.equal(tagKey("ClaudeCode"), tagKey("claude_code"));
  assert.equal(tagKey("Node.js"), tagKey("nodejs"));
  assert.notEqual(tagKey("Claude"), tagKey("ClaudeCode"));
});

function tempVault() {
  return createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "vocab-test-")));
}

test("vocabulary resolves spelling variants and seeded aliases to one canonical tag", () => {
  const vocab = createTagVocabulary(tempVault());
  vocab.resolve(["ClaudeCode"]); // 第一次出現，建立
  for (const variant of ["Claude Code", "claude-code", "CLAUDECODE"]) {
    assert.deepEqual(vocab.resolve([variant]).tags, ["ClaudeCode"], variant);
  }
  assert.deepEqual(vocab.resolve(["Vue3", "JS"]).tags, ["Vue", "JavaScript"], "seeded aliases");
});

test("new tags are created, reported, persisted, and de-duplicated within one call", () => {
  const vault = tempVault();
  const first = createTagVocabulary(vault).resolve(["Rust Lang", "rust-lang", "Docker"]);
  assert.deepEqual(first.tags, ["RustLang", "Docker"]);
  assert.deepEqual(first.created, ["RustLang", "Docker"]);

  const again = createTagVocabulary(vault).resolve(["rustlang"]); // 重新讀檔
  assert.deepEqual(again, { tags: ["RustLang"], created: [] });
  assert.ok(fs.existsSync(vault.absPath("_系統/tags.json")));
});

test("vocabulary lists canonical tags for the prompt", () => {
  const vocab = createTagVocabulary(tempVault());
  vocab.resolve(["Docker", "Vue"]);
  assert.ok(vocab.list().includes("Docker"));
  assert.ok(vocab.list().includes("Vue"));
});

test("user-edited tags.json aliases are honoured", () => {
  const vault = tempVault();
  vault.writeFile("_系統/tags.json", JSON.stringify({ tags: { PostgreSQL: ["Postgres", "PG"] } }));
  assert.deepEqual(createTagVocabulary(vault).resolve(["postgres", "PG"]).tags, ["PostgreSQL"]);
});
