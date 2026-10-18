import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createPipeline } from "../src/pipeline.js";

// 相關筆記與分類地圖都透過 Pipeline 驗證：依序存幾篇筆記，再看 vault 裡的連結與地圖。
function vaultWithPipeline() {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "linking-test-")));
  let next;
  const pipeline = createPipeline({
    vault,
    ai: { name: "fake", ask: async () => "", askJson: async () => next },
    fetcher: { fetch: async (url) => ({ url, ok: false, error: "x" }) },
    notebook: {},
    git: { commitAndPush: async () => ({ attempted: false }) },
  });
  const save = async (title, category, subcategory, primary_tag, tags = []) => {
    next = {
      category,
      subcategory,
      primary_tag,
      tags,
      title,
      summary: "s",
      kind: "觀念",
      tldr: "t",
      key_points: ["k"],
      content: "c",
      review_questions: [{ question: "q", answer: "a" }],
    };
    return pipeline.processIncomingContent(`${title} 測試內容`, "test");
  };
  return { vault, save };
}

const related = (vault, relPath) => {
  const body = vault.readNote(relPath).body;
  const section = body.split("## 相關筆記")[1] || "";
  return [...section.matchAll(/\[\[([^\]|]+)\|/g)].map((m) => m[1]);
};

test("notes in the same tag folder link both ways, using full-path links", async () => {
  const { vault, save } = vaultWithPipeline();
  const a = await save("Vue 生命週期", "技術", "前端框架", "Vue");
  const b = await save("Vue 響應式原理", "技術", "前端框架", "Vue");

  assert.equal(b.relatedResult.linkedCount, 1);
  assert.deepEqual(related(vault, b.result.relativePath), ["技術/前端框架/Vue/Vue 生命週期"]);
  assert.deepEqual(related(vault, a.result.relativePath), ["技術/前端框架/Vue/Vue 響應式原理"]);
  assert.match(vault.readNote(a.result.relativePath).body, /\[\[技術\/前端框架\/Vue\/Vue 響應式原理\|Vue 響應式原理\]\]/);
});

test("across folders, only notes sharing 2+ tags are linked", async () => {
  const { vault, save } = vaultWithPipeline();
  const two = await save("Vite 打包 Vue 專案", "技術", "建置與工具", "Vite", ["Vue", "TypeScript"]);
  const one = await save("Vite 環境變數", "技術", "建置與工具", "Webpack", ["Vite"]);
  const target = await save("Vue SFC 編譯", "技術", "前端框架", "Vue", ["Vite", "TypeScript"]);

  assert.deepEqual(related(vault, target.result.relativePath), ["技術/建置與工具/Vite/Vite 打包 Vue 專案"]);
  assert.ok(related(vault, two.result.relativePath).includes("技術/前端框架/Vue/Vue SFC 編譯"));
  assert.ok(!related(vault, one.result.relativePath).includes("技術/前端框架/Vue/Vue SFC 編譯"));
});

test("inbox notes are never auto-linked", async () => {
  const { save } = vaultWithPipeline();
  await save("想法一", "收件匣", "靈感", "", ["A", "B"]);
  const out = await save("想法二", "收件匣", "靈感", "", ["A", "B"]);
  assert.equal(out.relatedResult.linkedCount, 0);
});

test("each 大項目 gets a map grouped by 中項目 (taxonomy order) and tag, with counts", async () => {
  const { vault, save } = vaultWithPipeline();
  await save("Vue 生命週期", "技術", "前端框架", "Vue");
  await save("Vue 響應式原理", "技術", "前端框架", "Vue");
  const out = await save("Docker 健康檢查", "技術", "DevOps與部署", "Docker");

  assert.deepEqual(out.mocResult, { updated: true, mocPath: "技術/技術地圖.md" });
  const map = vault.readFile("技術/技術地圖.md");
  assert.match(map, /## 前端框架[\s\S]*### Vue（2）[\s\S]*## DevOps與部署[\s\S]*### Docker（1）/);
  assert.match(map, /- \[\[技術\/前端框架\/Vue\/Vue 生命週期\|Vue 生命週期\]\]/);
  assert.equal(vault.readFile("收件匣/收件匣地圖.md"), null);
});
