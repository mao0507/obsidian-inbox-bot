import fs from "node:fs";
import path from "node:path";
import { VAULT_PATH } from "./config.js";

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

function listMdFiles(dirAbs, out) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      listMdFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

function stripQuotes(str) {
  const trimmed = str.trim();
  const m = trimmed.match(/^"(.*)"$/) || trimmed.match(/^'(.*)'$/);
  return m ? m[1] : trimmed;
}

// 從一篇筆記的 frontmatter 裡取出 source 跟 other_sources 列出的所有網址。
function extractSources(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const sources = [];

  const sourceLine = fm.match(/^source:\s*(.+)$/m);
  if (sourceLine) sources.push(stripQuotes(sourceLine[1]));

  const otherBlock = fm.match(/^other_sources:\n((?:[ \t]*-[ \t].+\n?)*)/m);
  if (otherBlock) {
    for (const line of otherBlock[1].split("\n")) {
      const m = line.match(/^[ \t]*-[ \t](.+)$/);
      if (m) sources.push(stripQuotes(m[1]));
    }
  }

  return sources.filter(Boolean);
}

/**
 * 掃描整個 vault，找出跟傳入 urls 陣列裡任何一個網址（正規化後）相符的既有筆記。
 * 找到就回傳相對路徑（相對於 VAULT_PATH），找不到回傳 null。
 * 每次即時掃描（不做常駐 cache）：筆記數量在幾百篇等級幾乎瞬間完成，
 * 這樣才不會跟使用者手動在 Obsidian 裡增刪筆記的狀態不同步。
 */
export function findDuplicateNote(urls) {
  if (!urls || urls.length === 0) return null;
  const normalizedTargets = new Set(urls.map(normalizeUrl).filter(Boolean));
  if (normalizedTargets.size === 0) return null;

  const files = [];
  listMdFiles(VAULT_PATH, files);

  for (const full of files) {
    let content;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const sources = extractSources(content);
    for (const s of sources) {
      if (normalizedTargets.has(normalizeUrl(s))) {
        return path.relative(VAULT_PATH, full);
      }
    }
  }

  return null;
}
