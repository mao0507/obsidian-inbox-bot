import fs from "node:fs";
import path from "node:path";

// Vault Note module：vault 裡 .md 筆記的讀、寫、走訪全部集中在這裡。
// frontmatter 格式只在這支檔案裡被寫出、也只在這裡被解析，其他 module 只拿到 Note 物件，
// 不用（也不該）自己再寫一份 regex 去讀 frontmatter。
//
// 這支不 import config.js：root 由呼叫端傳入（正式環境見 app.js），測試直接傳暫存資料夾。
//
// Note = { path, title, summary, tags, sources, frontmatter, body }
//   path：相對 vault 根目錄、一律用 "/" 分隔（Windows 也一樣）
//   sources：frontmatter 的 source + other_sources 合併成一個陣列
//   frontmatter：所有 frontmatter 欄位（type、kind、author、published、reading_time...）

// 以 "." 開頭的資料夾（.obsidian、.trash、.git）、node_modules、程式自己的 _系統（詞彙表、重建紀錄）都不是使用者的筆記。
export const SYSTEM_DIR = "_系統";
function isIgnoredDir(name) {
  return name.startsWith(".") || name === "node_modules" || name === SYSTEM_DIR;
}

const MAX_FILENAME_LENGTH = 60;

// 檔名 = 標題：人類讀得懂、專有名詞保留原本大小寫、允許空白。
// 拿掉檔案系統不允許的字元，以及會讓 Obsidian [[wikilink]] 失效的 # ^ [ ] |。
export function titleToFilename(title) {
  return (
    String(title || "")
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_FILENAME_LENGTH)
      .trim() || "未命名筆記"
  );
}

// ponytail: 一律用中文閱讀速度估算（約每分鐘 400 字），英文長文會略微高估。
const READING_CHARS_PER_MINUTE = 400;

function readingTime(body) {
  const chars = String(body || "").replace(/\s+/g, "").length;
  return `${Math.max(1, Math.ceil(chars / READING_CHARS_PER_MINUTE))} 分鐘`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yamlEscape(str) {
  // 簡單處理：含冒號、引號或開頭特殊字元就整體用雙引號包起來（parseScalar 會對應解回來）
  if (/[:#"'\n]/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function parseScalar(raw) {
  const trimmed = (raw || "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fallthrough，用原始文字
    }
  }
  const single = trimmed.match(/^'(.*)'$/);
  return single ? single[1] : trimmed;
}

// Obsidian 的 tag 不能含空白（有空白會被判定成無效標籤，UI 上會用刪除線顯示）。
// AI 有時候還是會生成像 "Claude Code" 這種含空白的 tag，這裡強制拿掉空白當最後防線。
function sanitizeTag(tag) {
  return String(tag).replace(/^#/, "").trim().replace(/\s+/g, "");
}

// 欄位順序：識別（title/type/kind）→ 來源 → 原文資訊 → 收錄資訊 → 內容摘要。
// 選填欄位沒值就整行不寫，不留空欄位。
function serializeFrontmatter(note) {
  const { title, tags, summary, sources, sourceChannel, reasoning, body } = note;
  const lines = ["---"];
  const optional = (key) => {
    const value = note[key];
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}:`, ...value.map((v) => `  - ${yamlEscape(String(v))}`));
    } else if (value) {
      lines.push(`${key}: ${yamlEscape(String(value))}`);
    }
  };
  lines.push(`title: ${yamlEscape(title)}`);
  optional("type");
  optional("kind");
  if (sources?.length) {
    lines.push(`source: ${yamlEscape(sources[0])}`);
    if (sources.length > 1) {
      lines.push("other_sources:");
      for (const s of sources.slice(1)) lines.push(`  - ${yamlEscape(s)}`);
    }
  }
  optional("original_title");
  optional("author");
  optional("provider");
  optional("price");
  optional("dates");
  optional("published");
  optional("channel");
  optional("duration");
  optional("topic");
  optional("notebook_id");
  optional("notebook_ids"); // 合併多份研究時，所有來源 notebook
  lines.push(`date_added: ${note.date_added || todayISO()}`);
  lines.push(`via: ${sourceChannel}`);
  lines.push(`reading_time: ${readingTime(body)}`);
  lines.push(`summary: ${yamlEscape(summary || "")}`);
  lines.push("tags:");
  for (const t of tags || []) {
    const clean = sanitizeTag(t);
    if (clean) lines.push(`  - ${clean}`);
  }
  if (note.cards?.length) {
    lines.push("cards:");
    for (const card of note.cards) lines.push(`  - ${yamlEscape(card)}`);
  }
  lines.push("status: 已整理");
  if (reasoning) lines.push(`classify_note: ${yamlEscape(reasoning)}`);
  lines.push("---");
  return lines.join("\n");
}

// 只支援 serializeFrontmatter 會寫出的 YAML 子集：`key: value` 跟「`key:` 底下接 `  - item`」的清單。
// 清單項目只歸屬於它上面那個 key，所以 other_sources 的網址不會被誤當成 tags。
// ponytail: 不是通用 YAML parser；使用者手寫 inline 清單（tags: [a, b]）會被當成字串，需要時再換 yaml 套件。
function parseFrontmatter(fmText) {
  const fields = {};
  let listKey = null;
  for (const line of fmText.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      fields[listKey].push(parseScalar(item[1]));
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) {
      listKey = null;
      continue;
    }
    if (kv[2].trim() === "") {
      listKey = kv[1];
      fields[listKey] = [];
    } else {
      listKey = null;
      fields[kv[1]] = parseScalar(kv[2]);
    }
  }
  return fields;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function parseNote(relPath, raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!match) {
    return { path: relPath, title: "", summary: "", tags: [], sources: [], frontmatter: {}, body: raw.trim() };
  }
  const fm = parseFrontmatter(match[1]);
  return {
    path: relPath,
    title: typeof fm.title === "string" ? fm.title : "",
    summary: typeof fm.summary === "string" ? fm.summary : "",
    tags: asList(fm.tags).filter(Boolean),
    sources: [...asList(fm.source), ...asList(fm.other_sources)].filter(Boolean),
    frontmatter: fm,
    body: (match[2] || "").trim(),
  };
}

/**
 * 改寫 frontmatter 裡某個清單欄位（例如 tags、cards）：fn(舊清單) -> 新清單；欄位不存在就原樣回傳。
 * 只動 frontmatter，不會誤改正文裡長得一樣的清單。
 */
export function mapFrontmatterList(content, key, fn) {
  const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!fm) return content;
  const block = new RegExp(`^(${key}:\\r?\\n)((?:[ \\t]+-[ \\t].*\\r?\\n?)+)`, "m");
  const updated = fm[0].replace(block, (_, head, items) => {
    const values = items
      .split(/\r?\n/)
      .map((line) => line.match(/^\s+-\s+(.*)$/)?.[1])
      .filter((v) => v !== undefined)
      .map(parseScalar);
    const next = [...new Set(fn(values).filter(Boolean))];
    return next.length ? `${head}${next.map((v) => `  - ${yamlEscape(String(v))}`).join("\n")}\n` : `${head}`;
  });
  return updated === fm[0] ? content : updated + content.slice(fm[0].length);
}

function renderNoteFile(note) {
  return `${serializeFrontmatter(note)}\n\n# ${note.title}\n\n${String(note.body).trim()}\n`;
}

/**
 * 指向 vault 內一篇筆記的 wikilink：用完整路徑（檔名可能跨資料夾重複，只寫檔名會連錯），顯示文字是檔名。
 * 例如 "技術/前端框架/Vue/Vue 生命週期.md" -> [[技術/前端框架/Vue/Vue 生命週期|Vue 生命週期]]
 */
export function wikiLink(relPath) {
  return `[[${relPath.replace(/\.md$/i, "")}|${basenameOf(relPath)}]]`;
}

/** 筆記路徑的檔名（不含資料夾與 .md）。 */
export function basenameOf(relPath) {
  return relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

function toRel(...parts) {
  return parts.filter(Boolean).join("/");
}

export function createNoteStore(root) {
  const abs = (relPath = "") => path.join(root, ...relPath.split("/").filter(Boolean));

  function walk(relDir, out) {
    let entries;
    try {
      entries = fs.readdirSync(abs(relDir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const rel = toRel(relDir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(entry.name)) walk(rel, out);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(rel);
      }
    }
    return out;
  }

  function readNote(relPath) {
    return parseNote(relPath, fs.readFileSync(abs(relPath), "utf8"));
  }

  return {
    /** 相對路徑 -> 絕對路徑 */
    absPath: abs,

    /**
     * 讀取 folder（相對路徑，"" = 整個 vault）底下遞迴所有筆記。
     * 每次都重新讀磁碟、不做快取，才不會跟使用者在 Obsidian 裡手動增刪的狀態不同步。
     * ponytail: 每次全讀所有檔案內容，幾百篇等級瞬間完成；上萬篇再加 mtime 快取。
     */
    listNotes(folder = "") {
      return walk(folder, []).map((rel) => {
        try {
          return readNote(rel);
        } catch (err) {
          return { path: rel, title: rel, summary: "", tags: [], sources: [], body: "", error: err.message };
        }
      });
    },

    readNote,

    /**
     * 把 draft 寫成 .md 到 vault 對應資料夾。檔名重複時自動加流水號，絕不覆蓋既有筆記。
     */
    writeNote(note) {
      const { folder, title } = note;
      const dirAbs = abs(folder);
      fs.mkdirSync(dirAbs, { recursive: true });

      const base = titleToFilename(title);
      let finalName = `${base}.md`;
      let counter = 2;
      while (fs.existsSync(path.join(dirAbs, finalName))) {
        finalName = `${base} (${counter}).md`;
        counter += 1;
      }

      const fullPath = path.join(dirAbs, finalName);
      fs.writeFileSync(fullPath, renderNoteFile(note), "utf8");

      return { relativePath: toRel(folder, finalName), fullPath };
    },

    /**
     * 用新的內容整份改寫既有筆記，路徑（檔名）不變，所以其他筆記連過來的 [[連結]] 都不會斷。
     * 收錄日期沿用原本的（note.date_added 沒給的話從原檔讀）。
     */
    overwriteNote(relPath, note) {
      const date_added = note.date_added || readNote(relPath).frontmatter.date_added;
      fs.writeFileSync(abs(relPath), renderNoteFile({ ...note, date_added }), "utf8");
      return { relativePath: relPath, fullPath: abs(relPath) };
    },

    /** 用 fn(原始內容) 改寫一篇筆記，內容沒變就不寫。回傳是否有寫入。 */
    updateNote(relPath, fn) {
      const raw = fs.readFileSync(abs(relPath), "utf8");
      const updated = fn(raw);
      if (updated === raw) return false;
      fs.writeFileSync(abs(relPath), updated, "utf8");
      return true;
    },

    /** 把筆記搬到另一個資料夾（檔名衝突就加流水號），回傳新的相對路徑。原資料夾變空會一併清掉。 */
    moveNote(relPath, toFolder) {
      const dirAbs = abs(toFolder);
      fs.mkdirSync(dirAbs, { recursive: true });
      const base = basenameOf(relPath);
      let finalName = `${base}.md`;
      for (let counter = 2; fs.existsSync(path.join(dirAbs, finalName)); counter++) finalName = `${base} (${counter}).md`;
      fs.renameSync(abs(relPath), path.join(dirAbs, finalName));
      this.deleteFile(relPath); // 只用來清空資料夾（檔案已經搬走）
      return toRel(toFolder, finalName);
    },

    /** 刪除檔案（不存在就略過），並往上清掉因此變空的資料夾（不會刪到 vault 根目錄）。 */
    deleteFile(relPath) {
      fs.rmSync(abs(relPath), { force: true });
      const parts = relPath.split("/").slice(0, -1);
      while (parts.length) {
        const dir = abs(parts.join("/"));
        try {
          if (fs.readdirSync(dir).length) break;
          fs.rmdirSync(dir);
        } catch {
          break;
        }
        parts.pop();
      }
    },

    /** 讀取任意檔案（例如 _系統/tags.json），不存在回傳 null。 */
    readFile(relPath) {
      try {
        return fs.readFileSync(abs(relPath), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    /** 直接整份寫入（例如自動產生的分類地圖），會覆蓋既有檔案。 */
    writeFile(relPath, content) {
      fs.mkdirSync(path.dirname(abs(relPath)), { recursive: true });
      fs.writeFileSync(abs(relPath), content, "utf8");
    },
  };
}
