import { VALID_FOLDERS, isValidFolder } from "./taxonomy.js";

// Note Drafting module：把使用者丟進來的內容（+ 抓到的網頁）交給 AI，拿回一份「已驗證」的 Draft。
// AI 回傳的是結構化欄位（TL;DR、重點、完整內容、回顧問題...），正文由這裡照「精讀模板」排版，
// 所以每一段一定存在、順序固定，不靠 AI 自己記得格式。
// 欄位必填檢查、不合法資料夾退回 收件匣/待整理，都在這裡做一次，不管背後是 CLI 還是 API backend。

const FALLBACK_FOLDER = "收件匣/待整理";
export const NOTE_KINDS = ["觀念", "片段", "踩雷", "其他"];

const stringArray = (description) => ({ type: "array", items: { type: "string" }, description });

export const FILE_NOTE_TOOL = {
  name: "file_note",
  description:
    "把內容整理成一篇「精讀筆記」存進 Obsidian：目標是日後不看原文也能完整理解、回顧時真的吸收得到資訊。",
  input_schema: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description:
          `這篇筆記要放進哪個資料夾。多數情況必須是下面清單中已存在的固定路徑之一：${VALID_FOLDERS.join("、")}。` +
          `另外還有三個動態分類，folder 要依內容組出對應層級：` +
          `"AI/<工具名稱，AI自訂>/<提示詞庫|教學文章|新聞動態|工具比較>"、` +
          `"學習/<書籍|課程|文章整理>/<主題或書名，AI自訂>"、` +
          `"旅遊/<國家，AI自訂>/<城市或地區，AI自訂>"。` +
          `AI 自訂的那一層請參考 system prompt 裡「動態分類目前已有名稱」優先重複使用既有名稱，不要創造新的相似變體。`,
      },
      title: {
        type: "string",
        description: "筆記標題，同時也是檔名：繁體中文為主，專有名詞保留原文大小寫（例如「Vue3 Router 路由管理」），60 字以內",
      },
      tags: stringArray("3~6 個主題標籤，不含 # 符號、不能有空白（例如要寫 \"ClaudeCode\" 不要寫 \"Claude Code\"）"),
      summary: { type: "string", description: "一句話摘要，放進 frontmatter，用於列表與搜尋" },
      kind: {
        type: "string",
        enum: NOTE_KINDS,
        description: "內容型態：觀念（原理、教學、說明）／片段（可直接複製使用的程式碼或設定）／踩雷（錯誤與解法）／其他（新聞、遊記、心得等）",
      },
      original_title: { type: "string", description: "原文標題（沒有原文就留空字串）" },
      author: { type: "string", description: "原文作者（內文看得出來才填，否則留空字串，不要猜）" },
      published: { type: "string", description: "原文發布日期 YYYY-MM-DD（內文看得出來才填，否則留空字串，不要猜）" },
      tldr: { type: "string", description: "TL;DR：最多 3 行，讀完就知道這篇在講什麼、結論是什麼" },
      key_points: stringArray("重點條列：3~8 點，每點一句完整的話（不是關鍵字），涵蓋最重要的結論、數據與做法"),
      content: {
        type: "string",
        description:
          "詳細內容（Markdown）：依原文的章節結構逐段完整整理，用 ### 小標分段。" +
          "保留所有數據、步驟、指令、程式碼（放進 code block）、範例與注意事項，不要濃縮成摘要、不要省略細節；" +
          "原文沒解釋清楚的背景可以補充，但要標示「補充：」。這是整篇筆記最主要的部分，長度以完整為準，沒有上限。",
      },
      actions: stringArray("延伸與可行動項目：讀完可以實際去做、去試、去查的事（沒有就給空陣列）"),
      review_questions: {
        type: "array",
        description: "3 個回顧問題，用來日後自我測驗是否真的理解，答案要具體",
        items: {
          type: "object",
          properties: { question: { type: "string" }, answer: { type: "string" } },
          required: ["question", "answer"],
        },
      },
      quotes: stringArray("原文關鍵摘錄：1~5 段最重要的原文句子，逐字引用不改寫，方便日後查證（沒有原文就給空陣列）"),
      reasoning: { type: "string", description: "簡短說明為什麼分到這個資料夾" },
    },
    required: ["folder", "title", "tags", "summary", "kind", "tldr", "key_points", "content", "review_questions"],
  },
};

const bulletList = (items) => items.map((item) => `- ${item}`).join("\n");
const quoteBlock = (text) =>
  String(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

// 回顧問題用可摺疊的 callout：先看問題、想過再點開答案。
function reviewQuestion({ question, answer }, i) {
  return `> [!question]- Q${i + 1}. ${question}\n${quoteBlock(answer)}`;
}

/** 依精讀模板把 Draft 的結構化欄位排成 Markdown 正文；空的選填段落整段省略。 */
export function renderNoteBody(draft) {
  const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
  const sections = [
    `> [!summary] TL;DR\n${quoteBlock(draft.tldr)}`,
    `## 重點\n\n${bulletList(asArray(draft.key_points))}`,
    `## 詳細內容\n\n${String(draft.content).trim()}`,
    asArray(draft.actions).length ? `## 延伸與行動\n\n${bulletList(asArray(draft.actions))}` : null,
    asArray(draft.review_questions).length
      ? `## 回顧問題\n\n${asArray(draft.review_questions).map(reviewQuestion).join("\n\n")}`
      : null,
    asArray(draft.quotes).length ? `## 原文摘錄\n\n${asArray(draft.quotes).map(quoteBlock).join("\n\n")}` : null,
  ];
  return sections.filter(Boolean).join("\n\n");
}

/**
 * @param {object} deps
 * @param {{ name: string, askJson: Function }} deps.backend  aiBackends.js 的任一 adapter
 * @param {(input) => { system: string, user: string }} deps.buildPrompts
 */
export function createNoteDrafter({ backend, buildPrompts }) {
  return {
    /**
     * @param {object} input
     * @param {string} input.rawText 使用者原始輸入的文字（可能包含網址、留言、想法）
     * @param {Array<{url:string, ok:boolean, title?:string, text?:string, error?:string}>} [input.fetched]
     * @param {string} input.sourceChannel
     * @returns Draft：AI 的結構化欄位 + 依模板排好的 body
     */
    async draftNote({ rawText, fetched = [], sourceChannel }) {
      const { system, user } = buildPrompts({ rawText, fetched, sourceChannel });
      const payload = await backend.askJson({ system, user, tool: FILE_NOTE_TOOL });

      const missing = FILE_NOTE_TOOL.input_schema.required.filter((key) => !(key in payload));
      if (missing.length) {
        throw new Error(
          `AI（${backend.name}）回傳的結果缺少欄位「${missing.join("、")}」：${JSON.stringify(payload).slice(0, 300)}`
        );
      }

      let folder = payload.folder;
      if (!isValidFolder(folder)) {
        console.warn(`[classifier] AI 選了不合法的資料夾「${folder}」，改放進 ${FALLBACK_FOLDER}`);
        folder = FALLBACK_FOLDER;
      }
      const kind = NOTE_KINDS.includes(payload.kind) ? payload.kind : "";

      return { ...payload, folder, kind, body: renderNoteBody(payload) };
    },
  };
}
