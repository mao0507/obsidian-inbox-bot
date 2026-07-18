import { FLAT_CATEGORIES, NESTED_TAXONOMY, RULES, renderTaxonomyTree } from "./taxonomy.js";
import { getDynamicFolderExamples } from "./vaultScan.js";

export const VALID_FOLDERS = [
  ...FLAT_CATEGORIES,
  ...Object.entries(NESTED_TAXONOMY).flatMap(([top, subs]) => subs.map((s) => `${top}/${s}`)),
];

const JSON_SCHEMA_DESC = `{
  "folder": string，多數情況必須是清單中「已存在」的固定路徑（扁平資料夾直接填資料夾本身，例如 "知識庫"；有子資料夾的填完整路徑，例如 "收件匣/待整理"）。
    例外是動態分類（AI、學習、旅遊）：其中一層或兩層由你依內容判斷組成，詳見 system prompt 裡的分類清單與「動態分類目前已有名稱」,
  "filename": string，檔名（不含副檔名 .md）,
  "title": string，筆記標題,
  "tags": string[]，3~6 個主題標籤，不含 # 符號、不能有空白（例如要寫 "ClaudeCode" 不要寫 "Claude Code"，多個單字直接連在一起或用連字號）,
  "summary": string，一到兩句話摘要,
  "reasoning": string，簡短說明為什麼分到這個資料夾,
  "body": string，Markdown 格式的筆記正文（不含 frontmatter）
}`;

export function buildSystemPrompt(sourceChannel) {
  const dynamicExamples = getDynamicFolderExamples();

  return `你是使用者的 Obsidian 知識庫管家。使用者會透過 Telegram 或網頁表單丟內容給你（網址、文章、程式碼片段、bug 記錄、想法等），你要判斷分類、補齊缺漏資訊，整理成一篇乾淨的筆記。

這是使用者 vault 目前的資料夾分類清單，只能選擇裡面已存在的路徑（有些是扁平資料夾、有些有固定子資料夾、有些是動態分類，見下面標註）：
${renderTaxonomyTree()}
${dynamicExamples ? `\n動態分類目前已有名稱（同一個工具/主題/地區優先重複使用這些既有名稱，不要創造新的相似變體）：\n${dynamicExamples}\n` : ""}
${RULES}

寫筆記時的原則：
- 標題和內文以繁體中文為主，程式碼、專有名詞維持原文。
- 如果來源是完整文章，整理成有結構的筆記（重點、程式碼區塊等），不用逐字翻譯全文，但重要細節、程式碼、指令要保留完整。
- 如果你判斷原文有遺漏的重要背景（例如提到某個套件/工具沒解釋），用你的知識簡短補充，並清楚標示這是補充說明。
- 資料不足以判斷分類時，一律回退到 收件匣/待整理，不要硬猜。
- 來源標記為 ${sourceChannel}。`;
}

export function buildUserPrompt({ rawText, fetched = [] }) {
  const sourceBlock = fetched
    .map((f, i) => {
      if (!f.ok) return `【來源 ${i + 1}：${f.url}】抓取失敗（${f.error}），只能靠網址本身與使用者留言判斷。`;
      return `【來源 ${i + 1}：${f.url}】\n標題：${f.title}\n作者：${f.byline || "未知"}\n摘要：${f.excerpt || "無"}\n內文：\n${f.text}`;
    })
    .join("\n\n---\n\n");

  return `使用者傳入的原始內容：\n${rawText || "(無文字，只有連結)"}\n\n${
    sourceBlock ? `擷取到的網頁內容：\n\n${sourceBlock}` : "(這則內容沒有網址，或網址抓取失敗)"
  }\n\n請把這則內容整理成一篇 Obsidian 筆記並決定分類。`;
}

// 給 CLI 模式用：CLI 沒有 tool-use，用純文字要求它只回 JSON。
export function buildCliPrompt(args) {
  return `${buildSystemPrompt(args.sourceChannel)}

${buildUserPrompt(args)}

輸出格式規定（非常重要）：
- 只能輸出一個 JSON 物件，不要有任何其他文字、不要用 markdown code fence 包住，不要有前言或結語。
- JSON 結構必須完全符合：
${JSON_SCHEMA_DESC}
- 不要呼叫任何工具、不要讀寫檔案，直接把結果 JSON 印出來就好。`;
}

// 短指令：搭配上面透過 stdin 餵進去的完整 prompt 一起用。
// 大部分 agent CLI（claude、cursor-agent 等）的用法都是「內容用 stdin 管進去，
// 指令用一個簡短的位置參數帶著」，例如 `git diff | agent -p "summarize this"`。
// 把完整 prompt 塞進一個很長的 CLI 參數在某些系統上可能超過命令列長度限制，
// 所以固定用這句短指令當參數，實際內容都在 stdin 裡。
export const CLI_SHORT_INSTRUCTION =
  "請完成上面由標準輸入提供的分類任務，只回傳一個符合規定格式的 JSON 物件，不要有其他文字。";
