import { mapFrontmatterList } from "./noteStore.js";
import { createLinkRewriter } from "./linkRewrite.js";

// 合併重複的概念卡（/cards）：AI 找出「其實是同一個概念、只是寫法不同」的卡片分組，
// 使用者確認後合併：被併入卡片的說明與來源搬進保留的卡片，全 vault 的連結與 frontmatter cards 清單改指向保留的卡片。

const CARD_DIR = "卡片";
const SOURCES = "## 來源";
const cardPath = (name) => `${CARD_DIR}/${name}.md`;
const quote = (text) =>
  text
    .split("\n")
    .map((line) => `  > ${line}`)
    .join("\n");

export const CARD_DUPLICATE_TOOL = {
  name: "duplicate_cards",
  description: "找出其實是同一個概念、只是名稱寫法不同的概念卡",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "每組是同一個概念的卡片；只是相關但不同的概念不要放在一起。沒有重複就給空陣列",
        items: {
          type: "object",
          properties: {
            keep: { type: "string", description: "要保留的卡片名稱（原樣照抄清單裡的名稱，選最通用、最清楚的那個）" },
            merge: { type: "array", items: { type: "string" }, description: "要併進 keep 的其他卡片名稱（原樣照抄）" },
            reason: { type: "string", description: "一句話說明為什麼是同一個概念" },
          },
          required: ["keep", "merge", "reason"],
        },
      },
    },
    required: ["groups"],
  },
};

function cardSummaries(vault) {
  return vault.listNotes(CARD_DIR).map((n) => {
    const name = n.path.slice(CARD_DIR.length + 1).replace(/\.md$/, "");
    const explanation = n.body.replace(/^# .*\n+/, "").split(`\n${SOURCES}`)[0].replace(/\s+/g, " ").trim();
    return { name, explanation: explanation.slice(0, 120) };
  });
}

/** 請 AI 找重複的卡片；只回傳卡片都存在、每張只出現在一組、真的有東西要合併的分組。 */
export async function findDuplicateCards(vault, ai) {
  const cards = cardSummaries(vault);
  const names = new Set(cards.map((c) => c.name));
  const raw = await ai.askJson({
    system:
      "你在整理使用者的概念卡。找出其實是同一個概念、只是名稱寫法不同（中英文、同義詞、括號補充）的卡片。" +
      "只是相關、上下位、或應用與原理的關係（例如 Proxy 與基於 Proxy 的響應式）不算重複，不要合併。",
    user: `概念卡清單（名稱：說明開頭）：\n${cards.map((c) => `- ${c.name}：${c.explanation}`).join("\n")}`,
    tool: CARD_DUPLICATE_TOOL,
  });
  const used = new Set();
  const groups = [];
  for (const g of raw?.groups || []) {
    if (!names.has(g.keep) || used.has(g.keep)) continue;
    const merge = [...new Set(g.merge || [])].filter((n) => names.has(n) && n !== g.keep && !used.has(n));
    if (!merge.length) continue;
    [g.keep, ...merge].forEach((n) => used.add(n));
    groups.push({ keep: g.keep, merge, reason: String(g.reason || "") });
  }
  return groups;
}

function appendToKeep(vault, keep, dup) {
  const raw = vault.readFile(cardPath(dup));
  if (raw === null) return false;
  const body = raw.replace(/^---[\s\S]*?\n---\n/, "");
  const [before, after = ""] = body.split(`\n${SOURCES}\n`);
  const explanation = before.replace(/^\s*# .*\n/, "").trim();
  const sourceLines = after.split("\n").filter((line) => line.trim());
  vault.updateNote(cardPath(keep), (content) => {
    const additions = [`- 併入自「${dup}」的說明：`, quote(explanation)];
    for (const line of sourceLines) {
      const link = line.match(/^- (\[\[[^\]|]+)/)?.[1];
      if (link && content.includes(link)) continue; // 這個來源保留的卡片已經有了
      additions.push(line);
    }
    const base = content.includes(SOURCES) ? content.trimEnd() : `${content.trimEnd()}\n\n${SOURCES}\n`;
    return `${base}\n${additions.join("\n")}\n`;
  });
  return true;
}

// 合併後同一篇筆記可能出現兩行一樣的卡片連結，只留一行
function dedupeCardLinks(content) {
  const seen = new Set();
  return content
    .split("\n")
    .filter((line) => {
      if (!line.startsWith(`- [[${CARD_DIR}/`)) return true;
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join("\n");
}

/**
 * 把 dups 併進 keep。回傳 { merged: 實際併入的卡片數, notesUpdated: 連結或 cards 清單有改到的筆記數 }。
 */
export function mergeCards(vault, keep, dups) {
  if (vault.readFile(cardPath(keep)) === null) throw new Error(`找不到要保留的卡片「${keep}」`);
  const merged = dups.filter((dup) => dup !== keep && appendToKeep(vault, keep, dup));
  const renamed = new Set(merged);
  const rewriteLinks = createLinkRewriter(new Map(merged.map((dup) => [cardPath(dup), cardPath(keep)])));
  const update = (content) =>
    dedupeCardLinks(mapFrontmatterList(rewriteLinks(content), "cards", (names) => names.map((n) => (renamed.has(n) ? keep : n))));

  let notesUpdated = 0;
  for (const note of vault.listNotes()) {
    if (note.path.startsWith(`${CARD_DIR}/`)) continue;
    if (vault.updateNote(note.path, update)) notesUpdated++;
  }
  merged.forEach((dup) => vault.deleteFile(cardPath(dup)));
  return { merged: merged.length, notesUpdated };
}
