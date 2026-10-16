import { mapFrontmatterList } from "./noteStore.js";
import { createTagVocabulary } from "./tagVocabulary.js";
import { rewriteVaultLinks } from "./linkRewrite.js";
import { regenerateMoc } from "./mocSync.js";
import { TAXONOMY } from "./taxonomy.js";

// tag 管理（/tags）：看 tag 使用量、把重複的 tag 併進另一個。
// 合併會：改所有筆記 frontmatter 的 tags、把以舊 tag 當主 tag 的資料夾搬到新 tag 底下、改寫指向搬家筆記的連結、
// 舊 tag 變成新 tag 的別名（之後 AI 再寫舊名也會自動變成新名）、重新產生受影響的分類地圖。

const isNote = (note) => !["MOC", "card"].includes(note.frontmatter?.type);

/** 每個 tag 用在幾篇筆記：[[tag, count], ...]，由多到少。 */
export function tagUsage(vault) {
  const counts = new Map();
  for (const note of vault.listNotes().filter(isNote)) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"));
}

/** 把 tag from 併進 into。回傳 { retagged: 改了 tags 的筆記數, moved: 搬資料夾的筆記數 }。 */
export function mergeTags(vault, from, into) {
  const vocab = createTagVocabulary(vault);
  const notes = vault.listNotes().filter(isNote);
  const fromName = vocab.lookup(from) || from;
  const intoName = vocab.lookup(into) || String(into).replace(/\s+/g, "");
  if (!vocab.lookup(from) && !notes.some((n) => n.tags.includes(fromName))) throw new Error(`找不到 tag「${from}」`);
  if (fromName === intoName) throw new Error(`「${from}」和「${into}」已經是同一個 tag`);

  vocab.mergeInto(fromName, intoName);

  let retagged = 0;
  const moves = new Map();
  const affectedTops = new Set();
  for (const note of notes) {
    if (note.tags.includes(fromName)) {
      vault.updateNote(note.path, (content) =>
        mapFrontmatterList(content, "tags", (tags) => tags.map((t) => (t === fromName ? intoName : t)))
      );
      retagged++;
    }
    // 以舊 tag 當主 tag 的資料夾（大/中/舊tag/筆記.md）搬到 大/中/新tag
    const [top, sub, tagFolder, file] = note.path.split("/");
    if (file && TAXONOMY[top] && tagFolder === fromName) {
      moves.set(note.path, vault.moveNote(note.path, `${top}/${sub}/${intoName}`));
      affectedTops.add(top);
    }
  }

  if (moves.size) rewriteVaultLinks(vault, moves);
  affectedTops.forEach((top) => regenerateMoc(vault, top));
  return { retagged, moved: moves.size };
}

export const SIMILAR_TAGS_TOOL = {
  name: "similar_tags",
  description: "找出其實是同一個主題、只是寫法不同的 tag",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "每組是同一個主題的 tag；只是相關、上下位（例如 Vue 與 Pinia）不要放在一起。沒有就給空陣列",
        items: {
          type: "object",
          properties: {
            keep: { type: "string", description: "要保留的 tag（原樣照抄清單裡的名稱，選最通用、用得最多的）" },
            merge: { type: "array", items: { type: "string" }, description: "要併進 keep 的其他 tag（原樣照抄）" },
            reason: { type: "string", description: "一句話說明為什麼是同一個主題" },
          },
          required: ["keep", "merge", "reason"],
        },
      },
    },
    required: ["groups"],
  },
};

/** 請 AI 找寫法不同的同一個 tag；只回傳 tag 都存在、每個只出現在一組、真的有東西要合併的分組。 */
export async function findSimilarTags(vault, ai) {
  const usage = tagUsage(vault);
  const names = new Set(usage.map(([tag]) => tag));
  // 附上 tag 所在的分類，讓 AI 分得出同名不同義（例如不同大項目底下的同一個字）
  const placeOf = new Map();
  for (const note of vault.listNotes().filter(isNote)) {
    const place = note.path.split("/").slice(0, 2).join("/");
    for (const tag of note.tags) if (!placeOf.has(tag)) placeOf.set(tag, place);
  }
  const raw = await ai.askJson({
    system:
      "你在整理使用者筆記的 tag。找出其實是同一個主題、只是寫法不同（大小寫、中英文、縮寫、版本號、單複數、同義詞）的 tag。" +
      "只是相關、上下位、或同一生態系的不同工具（例如 Vue 與 Pinia、React 與 Next.js）不算重複，不要合併。",
    user: `tag 清單（tag（筆記數）｜所在分類）：\n${usage.map(([tag, n]) => `- ${tag}（${n}）｜${placeOf.get(tag) || ""}`).join("\n")}`,
    tool: SIMILAR_TAGS_TOOL,
  });
  const used = new Set();
  const groups = [];
  for (const g of raw?.groups || []) {
    if (!names.has(g.keep) || used.has(g.keep)) continue;
    const merge = [...new Set(g.merge || [])].filter((t) => names.has(t) && t !== g.keep && !used.has(t));
    if (!merge.length) continue;
    [g.keep, ...merge].forEach((t) => used.add(t));
    groups.push({ keep: g.keep, merge, reason: String(g.reason || "") });
  }
  return groups;
}
