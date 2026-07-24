import fs from "node:fs";
import { vaultFilePath } from "./config.js";
import { parseNote } from "./noteIndex.js";

// 跟 noteIndex.js 用同一份忽略清單：這些不是使用者的分類資料夾，瀏覽時不該列出來。
const IGNORED_DIR_NAMES = new Set([".obsidian", ".trash", ".git", "node_modules"]);

function readDir(absPath) {
  try {
    return fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function countNotesRecursive(segments) {
  let count = 0;
  for (const entry of readDir(vaultFilePath(...segments))) {
    if (entry.isDirectory() && !IGNORED_DIR_NAMES.has(entry.name)) {
      count += countNotesRecursive([...segments, entry.name]);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      count += 1;
    }
  }
  return count;
}

/**
 * 列出 vault 裡某個資料夾「直接底下」的子分類（含各自遞迴筆記數）跟直接放在這一層的筆記。
 * segments 是相對 vault 根目錄的路徑片段陣列，[] 代表根目錄（也就是所有頂層分類）。
 * 直接反映磁碟上目前實際存在的資料夾/檔案——不是 taxonomy.js 裡設定的規則清單，
 * 兩者不一定完全一樣（例如還沒有任何筆記的動態分類子資料夾不會出現在這裡）。
 */
export function listFolder(segments = []) {
  const entries = readDir(vaultFilePath(...segments));

  const subfolders = entries
    .filter((e) => e.isDirectory() && !IGNORED_DIR_NAMES.has(e.name))
    .map((e) => {
      const childSegments = [...segments, e.name];
      return { name: e.name, segments: childSegments, noteCount: countNotesRecursive(childSegments) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  const notes = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => ({ name: e.name.replace(/\.md$/i, ""), segments: [...segments, e.name] }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  return { segments, subfolders, notes };
}

/**
 * 讀取單一筆記檔案，回傳 { title, summary, tags, body }（跟 noteIndex.js 的 parseNote 格式一致）。
 * segments 最後一段要是檔名本身（含 .md）。
 */
export function readNote(segments) {
  const absPath = vaultFilePath(...segments);
  const raw = fs.readFileSync(absPath, "utf8");
  return parseNote(raw);
}
