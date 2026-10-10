import { VALID_FOLDERS, isValidFolder } from "./taxonomy.js";

// Note Drafting module：把使用者丟進來的內容（+ 抓到的網頁）交給 AI，拿回一份「已驗證」的 Draft。
// 欄位必填檢查、不合法資料夾退回 收件匣/待整理，都在這裡做一次，不管背後是 CLI 還是 API backend。

const FALLBACK_FOLDER = "收件匣/待整理";

export const FILE_NOTE_TOOL = {
  name: "file_note",
  description: "把整理好的內容存成一篇 Obsidian 筆記：決定分類資料夾、檔名、標籤，並產生正文。",
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
      filename: {
        type: "string",
        description: "檔名（不含副檔名 .md），簡短明確，可用中文，避免 / \\ : * ? \" < > | 等符號",
      },
      title: { type: "string", description: "筆記標題" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3~6 個主題標籤，不含 # 符號、不能有空白（例如要寫 \"ClaudeCode\" 不要寫 \"Claude Code\"）",
      },
      summary: { type: "string", description: "一到兩句話摘要，會放進 frontmatter" },
      reasoning: { type: "string", description: "簡短說明為什麼分到這個資料夾" },
      body: { type: "string", description: "筆記正文，Markdown 格式（不含 frontmatter）" },
    },
    required: ["folder", "filename", "title", "tags", "summary", "body"],
  },
};

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

      if (!isValidFolder(payload.folder)) {
        console.warn(`[classifier] AI 選了不合法的資料夾「${payload.folder}」，改放進 ${FALLBACK_FOLDER}`);
        return { ...payload, folder: FALLBACK_FOLDER };
      }
      return payload;
    },
  };
}
