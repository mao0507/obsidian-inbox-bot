// Obsidian vault 的分類樹：資料夾固定三層「大項目/中項目/主tag」。
// - 大項目、中項目是固定清單（這裡維護），AI 只能從清單挑，不能自己發明 → 不會再出現同一主題被拆成兩個資料夾。
// - 第三層是這篇筆記的「主 tag」（從 vault 的 tag 詞彙表挑，見 tagVocabulary.js），其他 tag 只放 frontmatter。
// - 旅遊的中項目是國家、專案的中項目是專案名，這兩個不設固定清單（openSubcategory）。
// - 收件匣只有兩層（收件匣/中項目），不分 tag。
// - 「觀念 / 片段 / 踩雷」是內容型態，不是分類：放在 frontmatter 的 kind。
// 想加新的中項目，直接加進對應陣列即可，prompt 會自動帶到最新的樹。

export const TAXONOMY = {
  技術: {
    subcategories: [
      "前端框架",
      "語言基礎",
      "樣式與UI",
      "建置與工具",
      "跨平台與行動",
      "後端與API",
      "資料庫",
      "網路與通訊",
      "DevOps與部署",
      "架構與設計模式",
      "演算法與資料結構",
    ],
    hint: "程式與軟體開發技術。主 tag 是具體技術，例如 技術/前端框架/Vue、技術/建置與工具/Vite、技術/資料庫/PostgreSQL",
  },
  AI: {
    subcategories: ["編程助手", "模型與聊天", "Agent與自動化", "提示詞工程", "設計與創作", "產業動態", "工具比較"],
    hint:
      "所有 AI 相關內容都放這裡，不要放進技術或學習。主 tag 是具體工具或主題，例如 AI/編程助手/ClaudeCode、AI/模型與聊天/Claude、" +
      "AI/Agent與自動化/MCP。ClaudeCode（寫程式的 CLI 工具）跟 Claude（模型/聊天）是不同 tag",
  },
  學習: {
    subcategories: ["書籍", "課程", "思維與方法", "職涯", "理財"],
    hint: "非 AI 的書籍、課程、思維方法、職涯、理財。主 tag 是書名/課程名/主題，例如 學習/書籍/原子習慣、學習/思維與方法/拖延",
  },
  旅遊: {
    openSubcategory: true,
    hint: "中項目是國家（繁體中文，例如 日本、台灣），主 tag 是城市或地區，例如 旅遊/日本/北海道。美食、景點、住宿用一般 tag 表示",
  },
  生活: {
    subcategories: ["健康運動", "料理飲食", "購物開箱", "居家", "娛樂"],
    hint: "日常生活內容，例如 生活/料理飲食/咖啡",
  },
  專案: {
    openSubcategory: true,
    hint: "使用者自己的專案，中項目是專案名，主 tag 是模組或主題",
  },
  收件匣: {
    subcategories: ["暫時紀錄", "靈感", "待整理"],
    noTagLevel: true,
    hint: "判斷不出分類、只有連結沒說明意圖 → 待整理；短的個人想法 → 靈感；使用者說先記一下、之後再看 → 暫時紀錄",
  },
};

export const INBOX_FALLBACK = "收件匣/待整理";

// 資料夾名稱不能含路徑分隔或檔案系統不允許的字元（也防止 AI 回傳 "a/b" 造成多一層資料夾）。
const isSafeSegment = (name) => typeof name === "string" && name.trim() !== "" && !/[\\/:*?"<>|]/.test(name);

/**
 * 依分類組出資料夾路徑；大/中項目不在清單裡、或缺少主 tag 時回傳 null（呼叫端退回 INBOX_FALLBACK）。
 * primaryTag 應該已經過 tag 詞彙表正規化。
 */
export function buildFolder({ category, subcategory, primaryTag }) {
  const node = TAXONOMY[category];
  if (!node || !isSafeSegment(subcategory)) return null;
  if (!node.openSubcategory && !node.subcategories.includes(subcategory)) return null;
  if (node.noTagLevel) return `${category}/${subcategory}`;
  if (!isSafeSegment(primaryTag)) return null;
  return `${category}/${subcategory}/${primaryTag}`;
}

/** 給 prompt 用的分類樹說明。 */
export function renderTaxonomyTree() {
  return Object.entries(TAXONOMY)
    .map(([category, node]) => {
      const subs = node.openSubcategory ? "（中項目自訂，見說明）" : `：${node.subcategories.join("、")}`;
      return `- ${category}${subs}\n  說明：${node.hint}`;
    })
    .join("\n");
}

// 規則說明，會原封不動放進 system prompt 給 AI 判斷用
export const RULES = `
分類規則：
- category（大項目）、subcategory（中項目）只能從上面的分類樹挑，不能自己發明；旅遊的中項目是國家、專案的中項目是專案名。
- primary_tag 是第三層資料夾，代表這篇筆記「最主要在講的那個具體東西」（技術、工具、書名、地區…）。
  務必優先使用「既有資料夾」與「tag 詞彙表」裡已經有的名稱，同一個東西不要換一種寫法（例如已有 ClaudeCode 就不要寫 Claude Code）。
- tags 是其他相關標籤（不含 primary_tag），一樣優先使用詞彙表裡的名稱；tag 不能有空白。
- 內容橫跨多個技術時，primary_tag 選最主要的那個，其他放 tags。
- 收件匣不需要 primary_tag（填空字串）。內容不完整、判斷不出明確分類、或使用者只丟連結沒有說明意圖 → 收件匣/待整理。
`;
