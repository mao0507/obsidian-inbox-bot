// 同一個連結被丟進來兩次時（使用者忘記自己丟過、或分享訊息被轉傳兩次），
// 之前沒有任何檢查，會直接各自生一篇內容幾乎一樣的新筆記
//（就是 旅遊/日本/北海道 底下那兩組重複筆記的成因）。
// 這支模組在分類之前先比對 vault 裡所有筆記 frontmatter 的 source/other_sources，
// 找到就直接回報已存在，不會浪費一次 AI 分類、也不會生出重複筆記。

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "srsltid",
  "ref",
  "triedRedirect",
];

// 把網址正規化成方便比對的形式：
// - 拿掉常見的追蹤參數（不同次分享同一篇文章時最容易造成網址表面不同）
// - 拿掉結尾的斜線、hash
// - 小寫化 host（path 保留原樣，避免大小寫敏感的路徑被誤判成不同）
// 網址格式本身有問題（例如不是完整 URL）時退回單純的字串 trim + lower，還是能比對完全相同的字串。
export function normalizeUrl(raw) {
  if (!raw) return "";
  const str = String(raw).trim();
  try {
    const u = new URL(str);
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    u.hash = "";
    const pathname = u.pathname.replace(/\/+$/, "");
    const search = u.searchParams.toString();
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return str.toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * 掃描整個 vault，找出 frontmatter source/other_sources 跟傳入 urls 任何一個網址（正規化後）相符的既有筆記。
 * 找到就回傳相對路徑，找不到回傳 null。
 * 每次即時掃描（不做常駐 cache），才不會跟使用者手動在 Obsidian 裡增刪筆記的狀態不同步。
 */
export function findDuplicateNote(vault, urls) {
  if (!urls || urls.length === 0) return null;
  const targets = urls.map(normalizeUrl).filter(Boolean);
  if (targets.length === 0) return null;

  const hit = vault.listNotes().find((note) => note.sources.some((s) => targets.some((t) => sameItem(normalizeUrl(s), t))));
  return hit ? hit.path : null;
}

// 這些網站的網址最後一段是「同一個商品的不同場次」（例如旅行團的出發日期代碼），
// 只差最後一段就算同一篇。只對列出的網域這樣判斷：部落格的 /blog/vue 跟 /blog/vue/xxx 是不同文章。
const SAME_ITEM_DOMAINS = ["dtsgroup.com.tw"];

function sameItem(a, b) {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (!long.startsWith(`${short}/`) || long.slice(short.length + 1).includes("/")) return false;
  try {
    const host = new URL(short).hostname;
    return SAME_ITEM_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
