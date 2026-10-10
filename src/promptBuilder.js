import { RULES, renderTaxonomyTree } from "./taxonomy.js";

export function buildSystemPrompt(sourceChannel, dynamicExamples = "") {
  return `你是使用者的 Obsidian 知識庫管家。使用者會透過 Telegram 丟內容給你（網址、文章、程式碼片段、bug 記錄、想法等），你要判斷分類，並整理成一篇「精讀筆記」：日後不看原文也能完整理解，回顧時真的吸收得到資訊。

這是使用者 vault 目前的資料夾分類清單，只能選擇裡面已存在的路徑（有些是扁平資料夾、有些有固定子資料夾、有些是動態分類，見下面標註）：
${renderTaxonomyTree()}
${dynamicExamples ? `\n動態分類目前已有名稱（同一個工具/主題/地區優先重複使用這些既有名稱，不要創造新的相似變體）：\n${dynamicExamples}\n` : ""}
${RULES}

寫筆記時的原則：
- 標題和內文以繁體中文為主，程式碼、專有名詞維持原文。
- 完整優先，不要濃縮成摘要：content 依原文章節逐段整理，原文提到的每個步驟、指令、程式碼、數據、範例、注意事項都要保留；外文原文要完整翻譯成繁體中文的意思（不是只翻重點）。
- 讓人讀得懂、記得住：每段先講結論或目的再講細節；抽象概念配上原文的例子；步驟用編號清單；程式碼一律放 code block 並標註語言。
- TL;DR 與重點條列是給「之後快速回顧」用的，要寫成完整的句子與具體結論，不要只寫關鍵字。
- 回顧問題要問「理解」而不是「記憶」（例如「為什麼要這樣做？」「什麼情況下不適用？」），答案要具體。
- 原文關鍵摘錄要逐字引用原文，不要改寫；作者、發布日期看不出來就留空，不要猜。
- 如果你判斷原文有遺漏的重要背景（例如提到某個套件/工具沒解釋），用你的知識補充，並以「補充：」開頭標示。
- 使用者自己寫的想法、短筆記沒有原文可以整理時，忠實整理並適度延伸，不要灌水。
- 資料不足以判斷分類時，一律回退到 收件匣/待整理，不要硬猜。
- 來源標記為 ${sourceChannel}。`;
}

const VIDEO_INSTRUCTIONS = `這是影片，內容來自逐字稿：
- content 依影片章節分段（沒有章節就依主題分段），每段的 ### 小標前面加上該段起始的時間戳連結，直接沿用逐字稿裡的 [mm:ss](連結) 格式，點了能跳到影片那一秒。
- 逐字稿是口語，要整理成通順的書面語，但講者提到的每個步驟、數據、工具名稱、例子都要保留，不要只寫大綱。
- 原文關鍵摘錄引用講者原話時，後面附上時間戳連結。`;

function describeSource(f, i) {
  if (!f.ok) return `【來源 ${i + 1}：${f.url}】抓取失敗（${f.error}），只能靠網址本身與使用者留言判斷。`;
  if (f.kind === "video") {
    return `【影片 ${i + 1}：${f.url}】\n標題：${f.title}\n頻道：${f.channel || "未知"}\n長度：${f.duration || "未知"}\n${VIDEO_INSTRUCTIONS}\n\n${f.text}`;
  }
  return `【來源 ${i + 1}：${f.url}】\n標題：${f.title}\n作者：${f.byline || "未知"}\n摘要：${f.excerpt || "無"}\n內文：\n${f.text}`;
}

export function buildUserPrompt({ rawText, fetched = [] }) {
  const sourceBlock = fetched.map(describeSource).join("\n\n---\n\n");

  return `使用者傳入的原始內容：\n${rawText || "(無文字，只有連結)"}\n\n${
    sourceBlock ? `擷取到的內容：\n\n${sourceBlock}` : "(這則內容沒有網址，或網址抓取失敗)"
  }\n\n請把這則內容整理成一篇 Obsidian 筆記並決定分類。`;
}
