// vault 目錄：所有筆記與概念卡的「路徑、標題、摘要、tag」，給 AI 挑出跟某個主題/問題相關的筆記。
// 幾百篇的目錄一次放得進 prompt，比關鍵字搜尋準確，也不用架向量資料庫。
// ponytail: 筆記破千篇、目錄塞不進 prompt 時，再改成先用關鍵字粗篩或換成向量搜尋。

const MAX_SUMMARY_CHARS = 120;

export function buildCatalog(vault) {
  return vault
    .listNotes()
    .filter((n) => n.frontmatter?.type !== "MOC")
    .map((n) => {
      const isCard = n.frontmatter?.type === "card";
      // 卡片沒有 summary，取說明的開頭
      const summary = isCard ? n.body.replace(/^# .*\n+/, "").split("\n## ")[0] : n.summary;
      return {
        path: n.path,
        title: n.title || n.path,
        kind: isCard ? "card" : n.frontmatter?.type || "note",
        summary: String(summary || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS),
        tags: n.tags,
      };
    });
}

export const SELECT_NOTES_TOOL = {
  name: "select_notes",
  description: "從筆記目錄挑出跟主題最相關的筆記與概念卡",
  input_schema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "相關筆記的路徑（原樣照抄目錄裡的路徑），最相關的排前面；沒有相關的就給空陣列",
      },
    },
    required: ["paths"],
  },
};

/** 請 AI 從目錄挑出最多 max 篇相關筆記；只採用目錄裡真的存在的路徑、去除重複。 */
export async function selectRelevantNotes(ai, catalog, topic, { max = 25 } = {}) {
  const known = new Set(catalog.map((c) => c.path));
  const lines = catalog.map(
    (c) => `- ${c.path}｜${c.kind === "card" ? "概念卡" : c.kind}｜${c.title}｜${c.summary}${c.tags.length ? `｜#${c.tags.join(" #")}` : ""}`
  );
  const raw = await ai.askJson({
    system:
      `你在幫使用者從他的 Obsidian 筆記庫找資料。從目錄挑出跟主題直接相關、對理解或回答主題有幫助的筆記與概念卡，` +
      `最多 ${max} 篇，最相關的排前面。只是沾到邊的不要選。`,
    user: `主題：${topic}\n\n筆記目錄（路徑｜類型｜標題｜摘要｜tag）：\n${lines.join("\n")}`,
    tool: SELECT_NOTES_TOOL,
  });
  return [...new Set((raw?.paths || []).filter((p) => known.has(p)))].slice(0, max);
}
