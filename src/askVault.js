import { findRelevantNotes } from "./noteIndex.js";
import { askAi } from "./askAi.js";

const MAX_NOTES = 8;
const MAX_BODY_CHARS_PER_NOTE = 3000;

function buildPrompt(question, notes) {
  const noteBlocks = notes
    .map((note, i) => {
      const body =
        note.body.length > MAX_BODY_CHARS_PER_NOTE
          ? `${note.body.slice(0, MAX_BODY_CHARS_PER_NOTE)}...(內容過長，已截斷)`
          : note.body;
      return `【筆記 ${i + 1}】
路徑：${note.path}
標題：${note.title || "(無標題)"}
標籤：${note.tags.join("、") || "(無)"}
內文：
${body}`;
    })
    .join("\n\n---\n\n");

  return `你是使用者的 Obsidian 筆記查詢助理。使用者會問你問題，你只能根據下面提供的筆記內容回答，
不能用自己的知識或臆測補充筆記沒提到的資訊。如果提供的筆記內容不足以回答問題，
要老實說目前筆記庫裡沒有相關資料，不要瞎掰。

回答格式：
- 用繁體中文，內容較多時用條列式整理重點，方便在 Telegram 上閱讀。
- 結尾另起一行「📚 參考筆記：」列出你實際引用到的筆記標題。

以下是搜尋到的相關筆記（依相關性排序，共 ${notes.length} 篇）：

${noteBlocks}

使用者的問題：
${question}`;
}

/**
 * 根據 vault 裡現有筆記回答問題。流程：
 * 1. 用關鍵字搜尋找出相關筆記（noteIndex.js，純本機比對，不用呼叫 AI，速度快）
 * 2. 沒找到任何相關筆記就直接回覆「沒有資料」，不浪費一次 AI 呼叫
 * 3. 找到的話把筆記內容 + 問題一起丟給 AI，要求只根據提供的內容回答，避免瞎掰
 */
export async function answerFromVault(question) {
  const notes = findRelevantNotes(question, MAX_NOTES);

  if (notes.length === 0) {
    return {
      answer: `目前筆記庫裡沒有找到跟「${question}」相關的資料。`,
      matchedCount: 0,
      matchedNotes: [],
    };
  }

  const prompt = buildPrompt(question, notes);
  const answer = await askAi(prompt);

  return {
    answer,
    matchedCount: notes.length,
    matchedNotes: notes.map((n) => ({ path: n.path, title: n.title })),
  };
}
