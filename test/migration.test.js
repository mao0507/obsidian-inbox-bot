import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createPipeline } from "../src/pipeline.js";
import { createMigration } from "../src/migration.js";

// 舊格式筆記（重建前的 frontmatter：沒有 type 欄位）
function oldNote(vault, relPath, { title, source, via = "telegram", date = "2025-01-01", body = "舊內文", tags = ["x"] }) {
  const fm = [
    "---",
    `title: ${title}`,
    source ? `source: "${source}"` : null,
    `date_added: ${date}`,
    `via: ${via}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  vault.writeFile(relPath, `${fm}\n\n# ${title}\n\n${body}\n`);
}

function setup({ fetchable = {} } = {}) {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-")));
  const calls = { askJson: [], git: 0 };
  const ai = {
    name: "fake",
    ask: async () => "",
    askJson: async (input) => {
      calls.askJson.push(input);
      const title = (input.user.match(/原標題：([^）\n]+)/) || [])[1] || "無標題";
      return {
        category: "技術",
        subcategory: "前端框架",
        primary_tag: "Vue",
        tags: [],
        title: `新 ${title}`,
        summary: "s",
        kind: "觀念",
        tldr: "t",
        key_points: ["k"],
        content: "c",
        review_questions: [{ question: "q", answer: "a" }],
      };
    },
  };
  const fetcher = {
    fetch: async (url) => (fetchable[url] ? { url, ok: true, title: "原文", text: fetchable[url] } : { url, ok: false, error: "HTTP 404" }),
  };
  const git = { commitAndPush: async () => (calls.git++, { attempted: false }) };
  const pipeline = createPipeline({ vault, ai, fetcher, notebook: {}, git });
  return { vault, calls, migration: createMigration({ vault, pipeline, fetcher, pauseMs: 0 }) };
}

function seed(vault) {
  oldNote(vault, "知識庫/Vue/Vue3-生命週期.md", { title: "Vue3 生命週期", source: "https://a.com/vue" });
  oldNote(vault, "旅遊/日本/北海道/北海道懶人包.md", { title: "北海道懶人包", source: "https://b.com/hokkaido", date: "2025-03-01" });
  oldNote(vault, "旅遊/日本/北海道/北海道懶人包 (2).md", { title: "北海道懶人包", source: "https://b.com/hokkaido?utm_source=x", date: "2025-02-01" });
  oldNote(vault, "收件匣/靈感/突然想到.md", { title: "突然想到", body: "一個關於 Vite 的想法" });
  oldNote(vault, "知識庫/參考.md", { title: "參考", body: "延伸閱讀 [[Vue3-生命週期]] 與 [[北海道懶人包 (2)|那篇遊記]]" });
  // 不屬於這張 ticket 的：研究筆記、地圖、已經是新格式的筆記
  oldNote(vault, "AI/綜合/教學文章/某研究.md", { title: "某研究", via: "telegram-notebook" });
  vault.writeFile("旅遊/旅遊地圖.md", "---\ntitle: 旅遊地圖\ntype: MOC\n---\n\n# 旅遊 地圖\n");
  vault.writeNote({ folder: "技術/前端框架/Vue", title: "已是新格式", tags: ["Vue"], summary: "s", body: "b", type: "note", sourceChannel: "telegram" });
}

test("inventory: old-format notes only, same source URL grouped together", () => {
  const { vault, migration } = setup();
  seed(vault);

  const groups = migration.inventory();

  assert.deepEqual(
    groups.map((g) => g.oldPaths),
    [
      ["收件匣/靈感/突然想到.md"],
      ["旅遊/日本/北海道/北海道懶人包 (2).md", "旅遊/日本/北海道/北海道懶人包.md"],
      ["知識庫/Vue/Vue3-生命週期.md"],
      ["知識庫/參考.md"],
    ]
  );
});

test("plan is a dry run: writes the plan table with fetch status, changes no notes", async () => {
  const { vault, calls, migration } = setup({ fetchable: { "https://a.com/vue": "Vue 原文" } });
  seed(vault);
  const before = vault.listNotes().map((n) => n.path);

  await migration.plan();

  assert.deepEqual(vault.listNotes().map((n) => n.path), before);
  assert.equal(calls.askJson.length, 0);
  const table = vault.readFile("_系統/migration-plan.md");
  assert.match(table, /知識庫\/Vue\/Vue3-生命週期\.md.*✅/);
  assert.match(table, /北海道懶人包 \(2\)\.md.*北海道懶人包\.md.*合併/);
  assert.match(table, /突然想到\.md.*原筆記內容/);
});

test("trial rebuilds only N groups and keeps the old notes", async () => {
  const { vault, migration } = setup({ fetchable: { "https://a.com/vue": "Vue 原文" } });
  seed(vault);

  await migration.rebuild({ limit: 1 });

  const state = JSON.parse(vault.readFile("_系統/migration-state.json"));
  assert.equal(Object.keys(state.done).length, 1);
  assert.ok(vault.readNote("知識庫/Vue/Vue3-生命週期.md"), "old notes stay until finalize");
});

test("full run: merges duplicates, falls back to the old body, rewrites links, deletes old notes", async () => {
  const { vault, calls, migration } = setup({ fetchable: { "https://a.com/vue": "Vue 原文" } });
  seed(vault);

  await migration.rebuild({ limit: 1 });
  await migration.rebuild(); // 接著做完剩下的，不重做 trial 那組
  await migration.finalize();

  assert.equal(calls.askJson.length, 4, "each group drafted exactly once");
  const state = JSON.parse(vault.readFile("_系統/migration-state.json"));
  const newOf = (oldPath) => Object.values(state.done).find((d) => d.oldPaths.includes(oldPath)).newPath;

  // 同網址合併：兩篇舊筆記 -> 一篇，保留最早的收錄日期
  const hokkaido = vault.readNote(newOf("旅遊/日本/北海道/北海道懶人包.md"));
  assert.equal(newOf("旅遊/日本/北海道/北海道懶人包 (2).md"), newOf("旅遊/日本/北海道/北海道懶人包.md"));
  assert.equal(hokkaido.frontmatter.date_added, "2025-02-01");

  // 抓不到原文 -> 用原筆記內容
  const idea = calls.askJson.find((c) => c.user.includes("突然想到"));
  assert.match(idea.user, /一個關於 Vite 的想法/);

  // 舊筆記刪掉、連結改指向新筆記
  for (const old of ["知識庫/Vue/Vue3-生命週期.md", "旅遊/日本/北海道/北海道懶人包.md", "知識庫/參考.md"]) {
    assert.equal(vault.readFile(old), null, old);
  }
  const allText = vault.listNotes().map((n) => n.body).join("\n");
  assert.doesNotMatch(allText, /\[\[Vue3-生命週期\]\]/);

  // 研究筆記與已是新格式的筆記不受影響
  assert.ok(vault.readNote("AI/綜合/教學文章/某研究.md"));
  assert.ok(vault.readNote("技術/前端框架/Vue/已是新格式.md"));
});

test("finalize rewrites links in notes that were not migrated, keeping aliases", async () => {
  const { vault, migration } = setup({ fetchable: { "https://a.com/vue": "Vue 原文" } });
  seed(vault);
  oldNote(vault, "AI/綜合/教學文章/某研究.md", {
    title: "某研究",
    via: "telegram-notebook",
    body: "見 [[Vue3-生命週期]] 和 [[北海道懶人包 (2)|那篇遊記]]",
  });

  await migration.rebuild();
  await migration.finalize();

  const state = JSON.parse(vault.readFile("_系統/migration-state.json"));
  const newOf = (oldPath) => Object.values(state.done).find((d) => d.oldPaths.includes(oldPath)).newPath;
  const body = vault.readNote("AI/綜合/教學文章/某研究.md").body;
  const target = (p) => p.replace(/\.md$/, "");
  assert.ok(body.includes(`[[${target(newOf("知識庫/Vue/Vue3-生命週期.md"))}|`), body);
  assert.ok(body.includes(`[[${target(newOf("旅遊/日本/北海道/北海道懶人包 (2).md"))}|那篇遊記]]`), body);
});
