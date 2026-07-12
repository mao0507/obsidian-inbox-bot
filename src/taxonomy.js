// 這裡定義你的 Obsidian vault 分類架構。
// 之後想加新的技術分類/專案，直接照格式加進對應陣列即可，
// 不用改其他程式碼，classify.js 會自動把最新的樹狀結構送給 Claude。

export const TAXONOMY = {
  "00 Inbox": ["暫時紀錄", "靈感", "待整理"],
  "01 Knowledge": [
    "HTML", "CSS", "JavaScript", "TypeScript", "Vue", "Nuxt", "React",
    "Node.js", "NestJS", "SQL", "Docker", "Linux", "Kubernetes", "Git",
    "Design Pattern"
  ],
  "02 Projects": ["Lunch-System", "公司專案A", "Side Project"],
  "03 Snippets": ["Vue", "TS", "SQL", "Docker", "Regex"],
  "04 Bugs": ["Vue", "Docker", "MSSQL", "Linux", "Mac"],
  "05 Learning": ["書籍", "課程", "文章整理"],
  "Assets": ["Images", "PDF"]
};

// 規則說明，會原封不動放進 system prompt 給 Claude 判斷用
export const RULES = `
分類規則：
- 明確對應到某個技術（Vue、Docker、SQL...）→ 歸進 01 Knowledge / 03 Snippets / 04 Bugs 對應子資料夾
  - 觀念、教學、原理類 → 01 Knowledge
  - 可直接複製貼上的程式碼片段 → 03 Snippets
  - 踩雷記錄、錯誤訊息與解法 → 04 Bugs
- 專案相關內容 → 02 Projects 對應子資料夾
- 書籍筆記、課程筆記、文章整理/心得 → 05 Learning
- 圖片、PDF 等純附件 → Assets
- 內容不完整、判斷不出明確分類、或使用者只丟了一個連結沒有說明意圖 → 00 Inbox/待整理
- 使用者丟的是想法/靈感片段（沒有連結、很短、偏個人思考）→ 00 Inbox/靈感
- 使用者明確說「先記一下」「之後再看」等 → 00 Inbox/暫時紀錄
- 只能選擇上面樹狀結構中「已存在」的資料夾，不要自己發明新資料夾名稱。
  如果真的完全不合適，一律回退到 00 Inbox/待整理。
`;

export function renderTaxonomyTree() {
  return Object.entries(TAXONOMY)
    .map(([top, subs]) => `- ${top}\n${subs.map((s) => `  - ${top}/${s}`).join("\n")}`)
    .join("\n");
}
