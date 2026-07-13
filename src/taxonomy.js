// 這裡定義你的 Obsidian vault 分類架構。
// 之後想加新分類，直接照格式加進對應陣列即可，不用改其他程式碼，
// classify.js 會自動把最新的樹狀結構送給 AI。

// FLAT_CATEGORIES：這幾個資料夾不建技術子資料夾，筆記直接放進資料夾本身，
// 技術分類完全靠 tags 處理（例如一篇筆記可以同時貼 #Vue #TypeScript）。
// 這是為了解決「內容橫跨兩個技術時，樹狀子資料夾逼你只能二選一」的問題。
export const FLAT_CATEGORIES = ["01 Knowledge", "03 Snippets", "04 Bugs"];

// NESTED_TAXONOMY：這幾個分類彼此互斥（一篇筆記通常明確屬於某一個子分類），
// 保留樹狀子資料夾結構。
export const NESTED_TAXONOMY = {
  "00 Inbox": ["暫時紀錄", "靈感", "待整理"],
  "02 Projects": ["Lunch-System", "公司專案A", "Side Project"],
  "05 Learning": ["書籍", "課程", "文章整理"],
  "06 AI": ["提示詞庫", "教學文章", "新聞動態", "工具比較"],
  "Assets": ["Images", "PDF"],
};

// DYNAMIC_TAXONOMY：子資料夾不是固定清單，而是 AI 依內容動態決定，
// 只規定固定的階層深度與每一層代表什麼。
// 例如「07 旅遊」依文章描述的地區建立「國家/城市或地區」兩層資料夾，
// 不需要（也不可能）事先把所有國家城市都列在清單裡。
export const DYNAMIC_TAXONOMY = {
  "07 旅遊": {
    depth: 2,
    levelNames: ["國家", "城市或地區"],
    hint: '依文章主要描述的地區判斷，用繁體中文，例如 "07 旅遊/台灣/台中"、"07 旅遊/日本/北海道"。地區不明確時不要用這個分類，改回 00 Inbox/待整理。',
  },
};

// 規則說明，會原封不動放進 system prompt 給 AI 判斷用
export const RULES = `
分類規則：
- 明確對應到某個技術（Vue、Docker、SQL...）→ folder 選 01 Knowledge / 03 Snippets / 04 Bugs 本身（這三個是扁平資料夾，不分技術子資料夾）。技術分類改用 tags 標註，一篇筆記可以同時貼多個技術 tag（例如內容橫跨 Vue 和 TypeScript，兩個 tag 都貼上，不用勉強只選一個技術）
  - 觀念、教學、原理類 → 01 Knowledge
  - 可直接複製貼上的程式碼片段 → 03 Snippets
  - 踩雷記錄、錯誤訊息與解法 → 04 Bugs
- 專案相關內容 → 02 Projects 對應子資料夾
- AI 相關內容（不論哪個工具、哪種型態）→ 一律進 06 AI 對應子資料夾，不要進 05 Learning：
  - 提示詞、prompt 範例、prompt 庫 → 06 AI/提示詞庫
  - AI 工具/技術的教學、操作說明、觀念文章 → 06 AI/教學文章
  - AI 產業新聞、發布公告、更新動態 → 06 AI/新聞動態
  - 多個 AI 工具的比較、選型評估 → 06 AI/工具比較
- 非 AI 的書籍筆記、課程筆記、一般文章整理/心得 → 05 Learning 對應子資料夾
- 圖片、PDF 等純附件 → Assets
- 旅遊相關內容（遊記、景點、行程規劃、美食、住宿心得等）→ 07 旅遊，這是動態分類，
  folder 請自己組成 "07 旅遊/國家/城市或地區"（依文章主要描述的地區判斷，用繁體中文），
  不要用清單裡沒列出的固定名稱去猜、也不要只填到 "07 旅遊" 這一層。
  如果文章沒有明確的地區資訊，不要用這個分類，改回 00 Inbox/待整理。
- 內容不完整、判斷不出明確分類、或使用者只丟了一個連結沒有說明意圖 → 00 Inbox/待整理
- 使用者丟的是想法/靈感片段（沒有連結、很短、偏個人思考）→ 00 Inbox/靈感
- 使用者明確說「先記一下」「之後再看」等 → 00 Inbox/暫時紀錄
- 除了「07 旅遊」這種動態分類外，只能選擇下面清單中「已存在」的資料夾，不要自己發明新資料夾名稱。
  如果真的完全不合適，一律回退到 00 Inbox/待整理。
`;

export function renderTaxonomyTree() {
  const flatLines = FLAT_CATEGORIES.map(
    (f) => `- ${f}（扁平資料夾，不分子資料夾，技術用 tags 表示，folder 直接填 "${f}"）`
  );
  const nestedLines = Object.entries(NESTED_TAXONOMY).map(
    ([top, subs]) => `- ${top}\n${subs.map((s) => `  - ${top}/${s}`).join("\n")}`
  );
  const dynamicLines = Object.entries(DYNAMIC_TAXONOMY).map(
    ([top, cfg]) =>
      `- ${top}（動態分類，沒有固定子資料夾清單，folder 自己組成 "${top}/${cfg.levelNames.join("/")}"。${cfg.hint}）`
  );
  return [...flatLines, ...nestedLines, ...dynamicLines].join("\n");
}

// 判斷 folder 是不是合法路徑：
// - 扁平分類：完全等於清單中的資料夾本身
// - 樹狀分類：完全等於 "頂層/子資料夾" 且子資料夾在清單裡
// - 動態分類：以 "頂層/" 開頭，且後面的階層數剛好等於規定的 depth、每一層都非空白
export function isValidFolder(folder) {
  if (typeof folder !== "string" || !folder.trim()) return false;

  if (FLAT_CATEGORIES.includes(folder)) return true;

  for (const [top, subs] of Object.entries(NESTED_TAXONOMY)) {
    if (subs.some((s) => folder === `${top}/${s}`)) return true;
  }

  for (const [top, cfg] of Object.entries(DYNAMIC_TAXONOMY)) {
    if (folder.startsWith(`${top}/`)) {
      const rest = folder
        .slice(top.length + 1)
        .split("/")
        .filter((seg) => seg.trim().length > 0);
      if (rest.length === cfg.depth) return true;
    }
  }

  return false;
}
