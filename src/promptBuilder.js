import { FLAT_CATEGORIES, NESTED_TAXONOMY, RULES, renderTaxonomyTree } from "./taxonomy.js";
import { getDynamicFolderExamples } from "./vaultScan.js";

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
