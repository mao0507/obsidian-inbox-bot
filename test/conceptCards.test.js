import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createPipeline } from "../src/pipeline.js";

// 概念卡透過 Pipeline 驗證：存幾篇帶 concepts 的筆記，再看卡片與主筆記。
function vaultWithPipeline() {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "cards-test-")));
  let next;
  const pipeline = createPipeline({
    vault,
    ai: { name: "fake", ask: async () => "", askJson: async () => next },
    fetcher: { fetch: async (url) => ({ url, ok: false, error: "x" }) },
    notebook: {},
    git: { commitAndPush: async () => ({ attempted: false }) },
  });
  const save = async (title, concepts) => {
    next = {
      category: "技術",
      subcategory: "前端框架",
      primary_tag: "Vue",
      tags: [],
      title,
      summary: "s",
      kind: "觀念",
      tldr: "t",
      key_points: ["k"],
      content: "c",
      review_questions: [{ question: "q", answer: "a" }],
      concepts,
    };
    return pipeline.processIncomingContent(title, "test");
  };
  return { vault, save };
}

const cardFiles = (vault) => vault.listNotes("卡片").map((n) => n.path);

test("a concept becomes a card that links back to the note, and the note links the card", async () => {
  const { vault, save } = vaultWithPipeline();
  const out = await save("Vue Composables 入門", [{ name: "Composables", explanation: "把可重用的狀態邏輯包成函式" }]);

  assert.deepEqual(cardFiles(vault), ["卡片/Composables.md"]);
  const card = vault.readNote("卡片/Composables.md");
  assert.equal(card.frontmatter.type, "card");
  assert.match(card.body, /把可重用的狀態邏輯包成函式/);
  assert.match(card.body, /\[\[技術\/前端框架\/Vue\/Vue Composables 入門\|Vue Composables 入門\]\]/);

  const note = vault.readNote(out.result.relativePath);
  assert.deepEqual(note.frontmatter.cards, ["Composables"]);
  assert.match(note.body, /## 概念卡\n\n- \[\[卡片\/Composables\|Composables\]\]/);
  assert.deepEqual(out.cards, [{ name: "Composables", created: true }]);
});

test("the same concept from another source appends to the existing card instead of creating a new one", async () => {
  const { vault, save } = vaultWithPipeline();
  await save("文章一", [{ name: "Composables", explanation: "第一篇的說法" }]);
  const out = await save("文章二", [{ name: "composables", explanation: "第二篇補充的重點" }]);

  assert.deepEqual(cardFiles(vault), ["卡片/Composables.md"]);
  const body = vault.readNote("卡片/Composables.md").body;
  assert.match(body, /第一篇的說法[\s\S]*文章一[\s\S]*文章二[\s\S]*第二篇補充的重點/);
  assert.deepEqual(out.cards, [{ name: "Composables", created: false }]);
});

test("tag vocabulary aliases also match cards (Postgres -> PostgreSQL)", async () => {
  const { vault, save } = vaultWithPipeline();
  await save("文章一", [{ name: "PostgreSQL", explanation: "關聯式資料庫" }]);
  await save("文章二", [{ name: "Postgres", explanation: "同一個東西" }]);
  assert.deepEqual(cardFiles(vault), ["卡片/PostgreSQL.md"]);
});

test("at most 3 cards per note; no concepts means no section", async () => {
  const { vault, save } = vaultWithPipeline();
  const many = ["A1", "B2", "C3", "D4"].map((name) => ({ name, explanation: name }));
  await save("很多概念", many);
  assert.equal(cardFiles(vault).length, 3);

  const none = await save("沒有概念", []);
  assert.doesNotMatch(vault.readNote(none.result.relativePath).body, /## 概念卡/);
});

test("saving the same note twice for a card does not duplicate its source entry", async () => {
  const { vault, save } = vaultWithPipeline();
  await save("同一篇", [{ name: "Ref", explanation: "x" }]);
  await save("同一篇", [{ name: "Ref", explanation: "x" }]); // 檔名會變成「同一篇 (2)」，是不同筆記
  const body = vault.readNote("卡片/Ref.md").body;
  assert.equal(body.match(/\[\[技術\/前端框架\/Vue\/同一篇\|/g).length, 1);
  assert.equal(body.match(/\[\[技術\/前端框架\/Vue\/同一篇 \(2\)\|/g).length, 1);
});
