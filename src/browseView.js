import { Markup } from "telegraf";
import { listFolder, readNote } from "./vaultBrowser.js";

// /browse 用的導覽狀態：Telegram inline button 的 callback_data 上限 64 bytes，
// 中文路徑（例如 "AI/ClaudeCode/教學文章"）動不動就超過，沒辦法把完整路徑塞進去，
// 所以改成「產生一個短 token 對應到實際路徑片段陣列」，callback_data 只帶 token。
// 純記憶體對照表，bot 重啟會清空（沒關係，舊按鈕原本就會失效，使用者重新 /browse 即可）；
// 用陣列額外記住插入順序，超過上限就從最舊的開始丟，避免長時間跑下來無限長大。
const BROWSE_TOKEN_LIMIT = 3000;
const browseTokens = new Map();
const browseTokenOrder = [];
let browseTokenSeq = 0;

function makeBrowseToken(segments) {
  const token = (browseTokenSeq++).toString(36);
  browseTokens.set(token, segments);
  browseTokenOrder.push(token);
  if (browseTokenOrder.length > BROWSE_TOKEN_LIMIT) {
    const oldest = browseTokenOrder.shift();
    browseTokens.delete(oldest);
  }
  return token;
}

export function resolveBrowseToken(token) {
  return browseTokens.get(token) ?? null;
}

const BROWSE_NOTES_PAGE_SIZE = 8;
const BROWSE_LABEL_MAX_LEN = 40;

function truncateLabel(name) {
  return name.length > BROWSE_LABEL_MAX_LEN ? `${name.slice(0, BROWSE_LABEL_MAX_LEN - 1)}…` : name;
}

// 畫出某個分類（資料夾）目前的子分類 + 直接放在這一層的筆記，回傳文字內容跟 inline keyboard。
// segments=[] 代表分類總覽（vault 根目錄下的所有頂層分類）。
export function renderFolderView(segments, notesPage = 0) {
  const { subfolders, notes } = listFolder(segments);
  const label = segments.join(" / ");
  const totalNotes = notes.length + subfolders.reduce((sum, f) => sum + f.noteCount, 0);

  const lines = [segments.length ? `📂 ${label}（共 ${totalNotes} 篇筆記）` : `📚 目前的分類（共 ${totalNotes} 篇筆記）`];
  if (!subfolders.length && !notes.length) {
    lines.push("這裡目前是空的。");
  } else if (subfolders.length) {
    lines.push("點下面的按鈕繼續往下查詢子分類或文章：");
  }

  const rows = [];
  for (const folder of subfolders) {
    const token = makeBrowseToken(folder.segments);
    rows.push([Markup.button.callback(`📁 ${truncateLabel(folder.name)}（${folder.noteCount}）`, `bf|${token}`)]);
  }

  const pageStart = notesPage * BROWSE_NOTES_PAGE_SIZE;
  const pageNotes = notes.slice(pageStart, pageStart + BROWSE_NOTES_PAGE_SIZE);
  for (const note of pageNotes) {
    const token = makeBrowseToken(note.segments);
    rows.push([Markup.button.callback(`📄 ${truncateLabel(note.name)}`, `bn|${token}`)]);
  }

  if (notes.length > BROWSE_NOTES_PAGE_SIZE) {
    const folderToken = makeBrowseToken(segments);
    const pagerRow = [];
    if (notesPage > 0) pagerRow.push(Markup.button.callback("⬅️ 上一頁", `bp|${folderToken}|${notesPage - 1}`));
    if (pageStart + BROWSE_NOTES_PAGE_SIZE < notes.length) {
      pagerRow.push(Markup.button.callback("下一頁 ➡️", `bp|${folderToken}|${notesPage + 1}`));
    }
    if (pagerRow.length) rows.push(pagerRow);
  }

  const navRow = [];
  if (segments.length > 0) {
    const parentToken = makeBrowseToken(segments.slice(0, -1));
    navRow.push(Markup.button.callback("⬅️ 上一層", `bf|${parentToken}`));
    const rootToken = makeBrowseToken([]);
    navRow.push(Markup.button.callback("🏠 分類總覽", `bf|${rootToken}`));
  }
  if (navRow.length) rows.push(navRow);

  return { text: lines.join("\n"), keyboard: Markup.inlineKeyboard(rows) };
}

// 畫出單篇筆記的詳細內容（標題、摘要、標籤、路徑、內文預覽）跟一個返回分類的按鈕。
export function renderNoteView(segments) {
  const note = readNote(segments);
  const relPath = segments.join("/");
  const bodyPreview =
    note.body && note.body.length > 800 ? `${note.body.slice(0, 800)}…\n\n（內容太長，完整版請到 Obsidian 打開）` : note.body;

  const lines = [
    `📄 ${note.title || relPath}`,
    note.summary ? `摘要：${note.summary}` : null,
    note.tags?.length ? note.tags.map((t) => `#${t}`).join(" ") : null,
    `路徑：${relPath}`,
    "",
    bodyPreview || "（沒有內文）",
  ].filter((line) => line !== null);

  const parentToken = makeBrowseToken(segments.slice(0, -1));
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback("⬅️ 返回分類", `bf|${parentToken}`)]]);

  return { text: lines.join("\n"), keyboard };
}
