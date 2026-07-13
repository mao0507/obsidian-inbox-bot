import fs from "node:fs";
import path from "node:path";
import { VAULT_PATH } from "./config.js";

const IGNORED_DIR_NAMES = new Set([".obsidian", ".trash", ".git", "node_modules"]);

function walkMarkdownFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// yamlEscape()（writeNote.js）遇到含冒號/井字號/引號的字串會整個用 JSON.stringify 包起來，
// 這裡對應把它解回原本的字串；不是那種格式就直接用原始文字。
function unquoteYamlValue(raw) {
  const trimmed = (raw || "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough，用原始文字
    }
  }
  return trimmed;
}

// 陽春版 frontmatter 解析，只抓 writeNote.js 會寫的幾個欄位（title/summary/tags），
// 格式跟 buildFrontmatter() 產生的一致，不是通用 YAML parser。
function parseNote(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { title: "", summary: "", tags: [], body: raw.trim() };
  }
  const fmText = match[1];
  const body = (match[2] || "").trim();

  const titleMatch = fmText.match(/^title:\s*(.*)$/m);
  const summaryMatch = fmText.match(/^summary:\s*(.*)$/m);
  const tags = [...fmText.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1].trim());

  return {
    title: unquoteYamlValue(titleMatch?.[1]),
    summary: unquoteYamlValue(summaryMatch?.[1]),
    tags,
    body,
  };
}

/**
 * 讀取 vault 裡所有筆記，回傳 { path(相對vault), title, summary, tags, body }[]。
 * 每次呼叫都重新讀取磁碟，不做快取——問答是使用者主動觸發的低頻操作，
 * 不需要為了效能犧牲「一定拿到最新內容」這件事。
 */
export function loadAllNotes() {
  const files = walkMarkdownFiles(VAULT_PATH);
  return files.map((full) => {
    const rel = path.relative(VAULT_PATH, full);
    try {
      const parsed = parseNote(fs.readFileSync(full, "utf8"));
      return { path: rel, ...parsed };
    } catch (err) {
      return { path: rel, title: rel, summary: "", tags: [], body: "", error: err.message };
    }
  });
}

// 把問題拆成拿來比對的關鍵字片段：整句本身、用標點斷開的每個詞、
// 以及每個詞裡長度 2~6 的連續子字串（因為中文沒有空白分詞，用滑動視窗抓片語，
// 例如「北海道有什麼景點」會拆出「北海道」「景點」等片段）。
function extractQueryTokens(query) {
  const tokens = new Set();
  const q = query.trim();
  if (!q) return tokens;

  const cleaned = q.replace(/[?？!！,，。.、\s]+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);

  for (const word of words.length ? words : [cleaned]) {
    if (word.length >= 2) tokens.add(word);
    for (let len = 2; len <= Math.min(6, word.length); len++) {
      for (let i = 0; i + len <= word.length; i++) {
        tokens.add(word.slice(i, i + len));
      }
    }
  }
  return tokens;
}

// 標題/路徑/tags/摘要這些欄位本身很短，命中不太可能是巧合，權重給高一點；
// 內文很長，2 個字的短片段在裡面幾乎一定會巧合出現（尤其中文），
// 所以短片段只在「短欄位」裡算數，內文只有 3 個字以上的片段命中才算分，
// 避免對完全不相關的問題也硬湊出幾篇「相關」筆記。
function scoreNote(note, query, tokens) {
  const shortFields = `${note.title}\n${note.path}\n${note.tags.join(" ")}\n${note.summary}`.toLowerCase();
  const body = note.body.toLowerCase();
  const q = query.trim().toLowerCase();
  let score = 0;

  if (q.length >= 2) {
    if (shortFields.includes(q)) score += 30;
    else if (body.includes(q)) score += 15;
  }

  for (const token of tokens) {
    const t = token.toLowerCase();
    if (t.length < 2) continue;

    if (t.length === 2) {
      if (shortFields.includes(t)) score += 3;
      continue;
    }

    if (shortFields.includes(t)) score += t.length * 2;
    else if (body.includes(t)) score += t.length;
  }

  return score;
}

const MIN_RELEVANCE_SCORE = 6;

/**
 * 從 vault 裡找出跟問題最相關的筆記，依分數由高到低排序，最多回傳 limit 篇。
 * 完全是關鍵字比對（沒有語意向量搜尋），但對「問某個地名/工具/主題有什麼資料」
 * 這種查詢已經足夠：只要相關筆記的標題、tags、內文裡有出現對應字詞就撈得到。
 * 分數太低（可能只是巧合命中一兩個短片段）會被濾掉，避免對不相關的問題硬湊筆記。
 */
export function findRelevantNotes(query, limit = 8) {
  const tokens = extractQueryTokens(query);
  const notes = loadAllNotes();

  return notes
    .map((note) => ({ note, score: scoreNote(note, query, tokens) }))
    .filter((x) => x.score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.note);
}
