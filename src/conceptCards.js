import { titleToFilename, wikiLink, basenameOf } from "./noteStore.js";
import { tagKey } from "./tagVocabulary.js";

// 概念卡：每篇主筆記額外抽出 0~3 個「可重複使用的概念」，存成 卡片/<概念>.md。
// 同一個概念被不同來源提到時不開新卡片，而是在既有卡片的「## 來源」追加這次的來源連結與補充，
// 卡片會跨來源累積；比對方式跟 tag 一樣（大小寫/空白/分隔符不同視為同一個，並套用 tag 詞彙表的別名）。

export const MAX_CARDS_PER_NOTE = 3;
const CARD_DIR = "卡片";
const SOURCES_HEADING = "## 來源";

const indent = (text) =>
  String(text)
    .trim()
    .split("\n")
    .map((line) => `  > ${line}`)
    .join("\n");

/**
 * 決定這篇筆記的概念要對應到哪些卡片（既有或新建），不寫檔。
 * @returns {Array<{ name, path, exists, explanation }>}
 */
export function planCards(vault, vocab, concepts) {
  const existing = new Map(vault.listNotes(CARD_DIR).map((n) => [tagKey(basenameOf(n.path)), n.path]));
  const plan = [];
  for (const concept of (concepts || []).filter((c) => c?.name?.trim())) {
    if (plan.length >= MAX_CARDS_PER_NOTE) break;
    const canonical = vocab.lookup(concept.name) || concept.name.trim();
    const found = existing.get(tagKey(canonical)) || existing.get(tagKey(concept.name));
    const path = found || `${CARD_DIR}/${titleToFilename(canonical)}.md`;
    if (plan.some((p) => p.path === path)) continue;
    plan.push({ name: basenameOf(path), path, exists: Boolean(found), explanation: concept.explanation || "" });
  }
  return plan;
}

/** 主筆記裡連到卡片的段落；沒有卡片回傳空字串。 */
export function renderCardSection(plan) {
  if (!plan.length) return "";
  return `## 概念卡\n\n${plan.map((card) => `- ${wikiLink(card.path)}`).join("\n")}`;
}

/** 依 planCards 的結果寫入卡片：新卡片建立檔案，既有卡片追加來源（同一篇筆記不重複追加）。 */
export function writeCards(vault, plan, { notePath }) {
  const link = wikiLink(notePath);
  for (const card of plan) {
    if (!card.exists) {
      vault.writeFile(
        card.path,
        [
          "---",
          `title: ${card.name}`,
          "type: card",
          `date_added: ${new Date().toISOString().slice(0, 10)}`,
          "---",
          "",
          `# ${card.name}`,
          "",
          card.explanation.trim(),
          "",
          SOURCES_HEADING,
          "",
          `- ${link}`,
          "",
        ].join("\n")
      );
      continue;
    }
    vault.updateNote(card.path, (content) => {
      if (content.includes(`[[${notePath.replace(/\.md$/i, "")}|`)) return content;
      const base = content.includes(SOURCES_HEADING) ? content.trimEnd() : `${content.trimEnd()}\n\n${SOURCES_HEADING}\n`;
      return `${base}\n- ${link}\n${card.explanation.trim() ? `${indent(card.explanation)}\n` : ""}`;
    });
  }
}
