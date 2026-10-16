import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { mergeCards, findDuplicateCards } from "../src/cardMerge.js";
import { mergeTags, tagUsage, findSimilarTags } from "../src/tagMerge.js";
import { createTagVocabulary } from "../src/tagVocabulary.js";

const tempVault = () => createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-")));

function card(vault, name, explanation, sources) {
  vault.writeFile(
    `卡片/${name}.md`,
    `---\ntitle: ${name}\ntype: card\n---\n\n# ${name}\n\n${explanation}\n\n## 來源\n\n${sources.map((s) => `- [[${s}|${s.split("/").pop()}]]`).join("\n")}\n`
  );
}

function note(vault, folder, title, { tags = [], cards = [], body = "內文" } = {}) {
  return vault.writeNote({ folder, title, tags, cards, summary: "s", body, type: "note", sourceChannel: "t" }).relativePath;
}

// ---- 概念卡 ----

test("mergeCards moves explanations and sources, rewrites links and cards lists, deletes duplicates", () => {
  const vault = tempVault();
  const a = note(vault, "技術/前端框架/Vue", "筆記A", { cards: ["Proxy 響應式"], body: "## 概念卡\n\n- [[卡片/Proxy 響應式|Proxy 響應式]]" });
  const b = note(vault, "技術/前端框架/Vue", "筆記B", { cards: ["Proxy", "Proxy 響應式"], body: "## 概念卡\n\n- [[卡片/Proxy|Proxy]]\n- [[卡片/Proxy 響應式|Proxy 響應式]]" });
  card(vault, "Proxy", "JS 的 Proxy 物件", [b.replace(/\.md$/, "")]);
  card(vault, "Proxy 響應式", "Vue 3 用 Proxy 做響應式", [a.replace(/\.md$/, ""), b.replace(/\.md$/, "")]);

  const result = mergeCards(vault, "Proxy", ["Proxy 響應式"]);

  assert.equal(vault.readFile("卡片/Proxy 響應式.md"), null);
  const kept = vault.readNote("卡片/Proxy.md").body;
  assert.match(kept, /JS 的 Proxy 物件[\s\S]*併入自「Proxy 響應式」[\s\S]*Vue 3 用 Proxy 做響應式/);
  assert.equal(kept.split(`[[${b.replace(/\.md$/, "")}|`).length, 2, "source already present is not duplicated");
  assert.ok(kept.includes(`[[${a.replace(/\.md$/, "")}|`), "new source moved over");

  assert.deepEqual(vault.readNote(a).frontmatter.cards, ["Proxy"]);
  assert.deepEqual(vault.readNote(b).frontmatter.cards, ["Proxy"]);
  assert.match(vault.readNote(a).body, /- \[\[卡片\/Proxy\|Proxy\]\]/, "alias follows the new name");
  assert.equal(vault.readNote(b).body.split("[[卡片/Proxy|Proxy]]").length, 2, "duplicate link line removed");
  assert.deepEqual(result, { merged: 1, notesUpdated: 2 });
});

test("findDuplicateCards keeps only valid groups of existing cards", async () => {
  const vault = tempVault();
  for (const name of ["A", "A2", "B", "C"]) card(vault, name, `${name} 說明`, []);
  const ai = {
    askJson: async (input) => {
      assert.match(input.user, /A2：A2 說明/);
      return {
        groups: [
          { keep: "A", merge: ["A2", "不存在"], reason: "同一個概念" },
          { keep: "B", merge: ["B"], reason: "只有自己" },
          { keep: "C", merge: ["A2"], reason: "A2 已經在別組" },
        ],
      };
    },
  };
  assert.deepEqual(await findDuplicateCards(vault, ai), [{ keep: "A", merge: ["A2"], reason: "同一個概念" }]);
});

// ---- tag ----

test("tagUsage counts notes per tag", () => {
  const vault = tempVault();
  note(vault, "技術/前端框架/Vue", "x", { tags: ["Vue", "Vuejs"] });
  note(vault, "技術/前端框架/Vue", "y", { tags: ["Vue"] });
  assert.deepEqual(tagUsage(vault), [
    ["Vue", 2],
    ["Vuejs", 1],
  ]);
});

test("mergeTags retags notes, moves the tag folder, rewrites links, keeps the old name as an alias", () => {
  const vault = tempVault();
  createTagVocabulary(vault).resolve(["Vue", "Vuejs"]);
  const moved = note(vault, "技術/前端框架/Vuejs", "Vuejs 筆記", { tags: ["Vuejs", "TypeScript"] });
  const stays = note(vault, "技術/前端框架/Vue", "Vue 筆記", { tags: ["Vue", "Vuejs"], body: "見 [[Vuejs 筆記]]" });

  const result = mergeTags(vault, "Vuejs", "Vue");

  assert.equal(vault.readFile(moved), null);
  const newPath = "技術/前端框架/Vue/Vuejs 筆記.md";
  assert.deepEqual(vault.readNote(newPath).tags, ["Vue", "TypeScript"]);
  assert.deepEqual(vault.readNote(stays).tags, ["Vue"]);
  assert.match(vault.readNote(stays).body, /\[\[技術\/前端框架\/Vue\/Vuejs 筆記\|Vuejs 筆記\]\]/);
  assert.deepEqual(createTagVocabulary(vault).resolve(["vuejs"]).tags, ["Vue"], "old tag now resolves to the kept one");
  assert.ok(!createTagVocabulary(vault).list().includes("Vuejs"));
  assert.deepEqual(result, { retagged: 2, moved: 1 });
});

test("mergeTags refuses unknown tags", () => {
  const vault = tempVault();
  assert.throws(() => mergeTags(vault, "沒有這個", "Vue"), /找不到 tag/);
});

test("findSimilarTags keeps only real, non-overlapping groups and shows the AI usage and placement", async () => {
  const vault = tempVault();
  note(vault, "技術/前端框架/Vue", "x", { tags: ["Vue", "Vuejs"] });
  note(vault, "技術/前端框架/Vue", "y", { tags: ["Vue", "Vue3", "Pinia"] });
  let prompt = "";
  const ai = {
    askJson: async ({ user }) => {
      prompt = user;
      return {
        groups: [
          { keep: "Vue", merge: ["Vuejs", "Vue3", "Vue", "不存在"], reason: "同一個框架" },
          { keep: "Vue3", merge: ["Pinia"], reason: "已被上一組用掉" },
          { keep: "不存在", merge: ["Pinia"], reason: "keep 不存在" },
          { keep: "Pinia", merge: [], reason: "沒東西可併" },
        ],
      };
    },
  };
  assert.deepEqual(await findSimilarTags(vault, ai), [{ keep: "Vue", merge: ["Vuejs", "Vue3"], reason: "同一個框架" }]);
  assert.match(prompt, /Vue（2）｜技術\/前端框架/);
});
