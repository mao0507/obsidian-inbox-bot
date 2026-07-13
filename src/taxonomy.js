// 這裡定義你的 Obsidian vault 分類架構。
// 之後想加新分類，直接照格式加進對應陣列即可，不用改其他程式碼，
// classify.js 會自動把最新的樹狀結構送給 AI。

// FLAT_CATEGORIES：這幾個資料夾不建技術子資料夾，筆記直接放進資料夾本身，
// 技術分類完全靠 tags 處理（例如一篇筆記可以同時貼 #Vue #TypeScript）。
// 這是為了解決「內容橫跨兩個技術時，樹狀子資料夾逼你只能二選一」的問題。
export const FLAT_CATEGORIES = ["01 Knowledge", "03 Snippets", "04 Bugs"];

// NESTED_TAXONOMY：這幾個分類彼此互斥、子資料夾是固定清單（一篇筆記通常明確
// 屬於某一個子分類），不會有跨分類的問題，也不需要 AI 自己發明資料夾名稱。
export const NESTED_TAXONOMY = {
  "00 Inbox": ["暫時紀錄", "靈感", "待整理"],
  "02 Projects": ["Lunch-System", "公司專案A", "Side Project"],
  "Assets": ["Images", "PDF"],
};

// DYNAMIC_TAXONOMY：至少有一層子資料夾不是固定清單，而是 AI 依內容動態決定。
// 每個分類用 levels 陣列描述每一層：
//   - type: "fixed"  → 這一層必須是 options 清單裡的其中一個值（跟 NESTED_TAXONOMY 一樣）
//   - type: "free"   → 這一層由 AI 依內容自己決定名稱（例如國家、工具名稱、書籍主題）
// depth（folder 的階層數）就是 levels.length，不用另外設定。
export const DYNAMIC_TAXONOMY = {
  // 旅遊筆記：國家、城市/地區都是 AI 自己判斷，兩層都沒有固定清單。
  "07 旅遊": {
    levels: [
      { name: "國家", type: "free" },
      { name: "城市或地區", type: "free" },
    ],
    hint: '依文章主要描述的地區判斷，用繁體中文，例如 "07 旅遊/台灣/台中"、"07 旅遊/日本/北海道"。地區不明確時不要用這個分類，改回 00 Inbox/待整理。',
  },
  // AI 相關筆記：先依「工具名稱」動態分資料夾（同一個工具的筆記會集中在一起），
  // 底下再依「內容型態」分成固定的四種。
  "06 AI": {
    levels: [
      { name: "工具名稱", type: "free" },
      { name: "型態", type: "fixed", options: ["提示詞庫", "教學文章", "新聞動態", "工具比較"] },
    ],
    hint:
      '第一層是工具/產品名稱，AI 自己判斷，用不含空白的簡潔名稱（例如 "ClaudeCode"、"Cursor"、"OpenAI"），' +
      '同一個工具要一律用同樣的名稱，不要每次取不同的變體（例如已經有 "ClaudeCode" 就不要又建 "Claude Code" 或 "Claude AI"）。' +
      '如果內容橫跨多個工具或講的是產業整體、沒有明確對應單一工具，工具名稱層填 "綜合"。' +
      '第二層固定選 "提示詞庫"、"教學文章"、"新聞動態"、"工具比較" 其中一個。' +
      '例如 "06 AI/ClaudeCode/教學文章"、"06 AI/綜合/新聞動態"。',
  },
  // 學習筆記：先依固定的「型態」分類，底下再依「主題或書籍名稱」動態分資料夾，
  // 讓同一本書、同一個主題的筆記集中在一起。
  "05 Learning": {
    levels: [
      { name: "型態", type: "fixed", options: ["書籍", "課程", "文章整理"] },
      { name: "主題或書籍名稱", type: "free" },
    ],
    hint:
      '第一層固定選 "書籍"、"課程"、"文章整理" 其中一個。' +
      '第二層是書名/課程名/主題，AI 自己判斷，用簡潔的繁體中文名稱，' +
      '同一本書、同一個主題要一律用同樣的名稱，不要每次取不同的變體。' +
      '例如 "05 Learning/書籍/原子習慣"、"05 Learning/文章整理/前端效能優化"。',
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
- AI 相關內容（不論哪個工具、哪種型態）→ 一律進 06 AI，不要進 05 Learning。folder 依「工具名稱/內容型態」兩層組成（見下面 06 AI 的動態分類說明）：
  - 提示詞、prompt 範例、prompt 庫 → .../提示詞庫
  - AI 工具/技術的教學、操作說明、觀念文章 → .../教學文章
  - AI 產業新聞、發布公告、更新動態 → .../新聞動態
  - 多個 AI 工具的比較、選型評估 → .../工具比較
- 非 AI 的書籍筆記、課程筆記、一般文章整理/心得 → 05 Learning，folder 依「型態/主題或書籍名稱」兩層組成（見下面 05 Learning 的動態分類說明）
- 圖片、PDF 等純附件 → Assets
- 旅遊相關內容（遊記、景點、行程規劃、美食、住宿心得等）→ 07 旅遊，這是動態分類，
  folder 請自己組成 "07 旅遊/國家/城市或地區"（依文章主要描述的地區判斷，用繁體中文），
  不要用清單裡沒列出的固定名稱去猜、也不要只填到 "07 旅遊" 這一層。
  如果文章沒有明確的地區資訊，不要用這個分類，改回 00 Inbox/待整理。
- 內容不完整、判斷不出明確分類、或使用者只丟了一個連結沒有說明意圖 → 00 Inbox/待整理
- 使用者丟的是想法/靈感片段（沒有連結、很短、偏個人思考）→ 00 Inbox/靈感
- 使用者明確說「先記一下」「之後再看」等 → 00 Inbox/暫時紀錄
- 動態分類（06 AI、05 Learning、07 旅遊）裡由 AI 自訂的那一層，務必參考 system prompt 裡列出的「動態分類目前已有名稱」，
  如果內容對應到已經存在的名稱就直接重複使用，不要創造新的相似變體（例如已有 "ClaudeCode" 就不要又建 "Claude Code"）。
- 除了動態分類的自訂層之外，folder 只能選擇下面清單中「已存在」的固定路徑，不要自己發明新資料夾名稱。
  如果真的完全不合適，一律回退到 00 Inbox/待整理。
`;

export function renderTaxonomyTree() {
  const flatLines = FLAT_CATEGORIES.map(
    (f) => `- ${f}（扁平資料夾，不分子資料夾，技術用 tags 表示，folder 直接填 "${f}"）`
  );
  const nestedLines = Object.entries(NESTED_TAXONOMY).map(
    ([top, subs]) => `- ${top}\n${subs.map((s) => `  - ${top}/${s}`).join("\n")}`
  );
  const dynamicLines = Object.entries(DYNAMIC_TAXONOMY).map(([top, cfg]) => {
    const levelDesc = cfg.levels
      .map((lv) => (lv.type === "fixed" ? `${lv.name}（固定選：${lv.options.join("/")}）` : `${lv.name}（AI 自訂）`))
      .join(" > ");
    return `- ${top}（動態分類，共 ${cfg.levels.length} 層：${levelDesc}。${cfg.hint}）`;
  });
  return [...flatLines, ...nestedLines, ...dynamicLines].join("\n");
}

// 判斷 folder 是不是合法路徑：
// - 扁平分類：完全等於清單中的資料夾本身
// - 樹狀分類：完全等於 "頂層/子資料夾" 且子資料夾在清單裡
// - 動態分類：以 "頂層/" 開頭，階層數要剛好等於 levels.length，
//   每一層如果是 fixed 要在該層的 options 裡、如果是 free 只要求非空白
export function isValidFolder(folder) {
  if (typeof folder !== "string" || !folder.trim()) return false;

  if (FLAT_CATEGORIES.includes(folder)) return true;

  for (const [top, subs] of Object.entries(NESTED_TAXONOMY)) {
    if (subs.some((s) => folder === `${top}/${s}`)) return true;
  }

  for (const [top, cfg] of Object.entries(DYNAMIC_TAXONOMY)) {
    if (!folder.startsWith(`${top}/`)) continue;
    const segments = folder
      .slice(top.length + 1)
      .split("/")
      .filter((seg) => seg.trim().length > 0);
    if (segments.length !== cfg.levels.length) continue;
    const ok = cfg.levels.every((level, i) => {
      const seg = segments[i];
      if (!seg) return false;
      if (level.type === "fixed") return level.options.includes(seg);
      return seg.trim().length > 0;
    });
    if (ok) return true;
  }

  return false;
}
