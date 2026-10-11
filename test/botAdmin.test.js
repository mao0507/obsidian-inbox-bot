import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { formatStatus, formatMigrationStatus, formatUptime, tailLines } from "../src/botAdmin.js";

test("uptime is human readable", () => {
  assert.equal(formatUptime(59), "59 秒");
  assert.equal(formatUptime(3 * 3600 + 120), "3 小時 2 分");
  assert.equal(formatUptime(2 * 86400 + 3600), "2 天 1 小時");
});

test("status lists queues, vault counts per top folder and tool availability", () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "status-test-")));
  vault.writeNote({ folder: "技術/前端框架/Vue", title: "a", tags: [], summary: "", body: "b", type: "note", sourceChannel: "t" });
  vault.writeNote({ folder: "技術/前端框架/Vue", title: "b", tags: [], summary: "", body: "b", type: "note", sourceChannel: "t" });
  vault.writeFile("技術/技術地圖.md", "---\ntitle: 技術地圖\ntype: MOC\n---\n");
  vault.writeFile("卡片/X.md", "---\ntitle: X\ntype: card\n---\n");

  const text = formatStatus({
    vault,
    uptimeSec: 3700,
    underPm2: true,
    lanes: { intake: 0, research: 2 },
    tools: { notebooklm: true, ytdlp: false },
    migrationState: null,
  });

  assert.match(text, /1 小時 1 分（pm2）/);
  assert.match(text, /一般收件 0 個、研究 2 個/);
  assert.match(text, /技術 2/);
  assert.match(text, /卡片 1/);
  assert.doesNotMatch(text, /技術 3/, "maps are not counted");
  assert.match(text, /NotebookLM ✅.*yt-dlp ❌/);
});

test("migration status summarises general and research progress and failures", () => {
  const state = {
    done: { a: { oldPaths: ["a"] }, b: { oldPaths: ["b"] }, r1: { oldPaths: ["r1", "r1b"] } },
    failed: { r2: "RateLimitError" },
    researchGroups: [{ oldPaths: ["r1", "r1b"] }, { oldPaths: ["r2"] }],
    finalizedAt: "2026-10-11T05:00:00.000Z",
  };
  const text = formatMigrationStatus(state);
  assert.match(text, /一般筆記：2 組完成/);
  assert.match(text, /研究筆記：1\/2 組完成/);
  assert.match(text, /❌ r2：RateLimitError/);
  assert.match(text, /\/migrate retry/);
  assert.equal(formatMigrationStatus(null), "還沒開始舊筆記重建（第一次請在電腦執行 pnpm run migrate plan）");
});

test("tailLines returns the last N lines of a file, or null when missing", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "log-test-")), "out.log");
  fs.writeFileSync(file, ["1", "2", "3", "4", ""].join("\n"));
  assert.equal(tailLines(file, 2), "3\n4");
  assert.equal(tailLines(`${file}.missing`, 2), null);
});
