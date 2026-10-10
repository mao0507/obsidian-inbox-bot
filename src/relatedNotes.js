import { TAXONOMY } from "./taxonomy.js";
import { wikiLink } from "./noteStore.js";

// 每次寫入新筆記之後執行，自動幫新筆記跟判斷為相關的既有筆記互相補上「## 相關筆記」區塊裡的連結。
// 「相關」：
// - 同一個「大項目/中項目/主tag」資料夾裡的筆記：同主題，一律互連。
// - 其他資料夾的筆記：至少共用 MIN_SHARED_TAGS 個 tag 才連（只共用 1 個 tag 太鬆，會連到不相干的筆記），
//   依共用 tag 數由多到少取前 MAX_CROSS_FOLDER_LINKS 篇，避免熱門 tag 讓相關區塊無限變長。
// - 收件匣不參與自動連結（零散項目，關聯意義不大）；分類地圖不算筆記。

const MIN_SHARED_TAGS = 2;
const MAX_CROSS_FOLDER_LINKS = 10;
const HEADING = "## 相關筆記";

const folderOf = (relPath) => relPath.slice(0, relPath.lastIndexOf("/"));

function isTagFolder(folder) {
  const parts = folder.split("/");
  return parts.length === 3 && Boolean(TAXONOMY[parts[0]]) && !TAXONOMY[parts[0]].noTagLevel;
}

// 純粹「加上一條連結」，不會動到區塊裡既有的其他連結（包含使用者自己手動加的）。
// 已經連過（新格式或舊的 [[檔名]] 格式）就不重複加；沒有「## 相關筆記」區塊就新增一段。
function addRelatedLink(content, targetPath) {
  const link = wikiLink(targetPath);
  const target = targetPath.replace(/\.md$/, "");
  const basename = target.slice(target.lastIndexOf("/") + 1);
  const headingIdx = content.indexOf(HEADING);

  if (headingIdx === -1) {
    return `${content.trimEnd()}\n\n${HEADING}\n\n- ${link}\n`;
  }

  const afterHeading = content.slice(headingIdx + HEADING.length);
  const nextHeadingRel = afterHeading.search(/\n#{1,6}[ \t]/);
  const sectionEndAbs = nextHeadingRel === -1 ? content.length : headingIdx + HEADING.length + nextHeadingRel;
  const section = content.slice(headingIdx, sectionEndAbs);

  if (section.includes(`[[${target}|`) || section.includes(`[[${basename}]]`)) return content;

  const before = content.slice(0, sectionEndAbs).replace(/\s+$/, "");
  const after = content.slice(sectionEndAbs);
  return `${before}\n- ${link}\n${after}`;
}

/**
 * 一篇新筆記寫進 folder（filename 含 .md）之後呼叫，雙向補上 [[wikilink]]。
 * 回傳 { linkedCount }：這次總共連結的既有筆記數，給呼叫端顯示狀態用。
 */
export function syncRelatedNotes(vault, { folder, filename, tags }) {
  if (!isTagFolder(folder)) return { linkedCount: 0 };

  const newPath = `${folder}/${filename}`;
  const newTags = new Set(tags || []);
  const candidates = vault
    .listNotes()
    .filter((note) => note.path !== newPath && isTagFolder(folderOf(note.path)) && note.frontmatter?.type !== "MOC");

  const sameFolder = candidates.filter((note) => folderOf(note.path) === folder);
  const crossFolder = candidates
    .filter((note) => folderOf(note.path) !== folder)
    .map((note) => ({ note, shared: note.tags.filter((t) => newTags.has(t)).length }))
    .filter(({ shared }) => shared >= MIN_SHARED_TAGS)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, MAX_CROSS_FOLDER_LINKS)
    .map(({ note }) => note);

  const relatedNotes = [...sameFolder, ...crossFolder];
  if (relatedNotes.length === 0) return { linkedCount: 0 };

  vault.updateNote(newPath, (content) => relatedNotes.reduce((acc, note) => addRelatedLink(acc, note.path), content));
  for (const note of relatedNotes) {
    try {
      vault.updateNote(note.path, (content) => addRelatedLink(content, newPath));
    } catch {
      // 讀寫單篇既有筆記失敗就跳過，不影響其他筆記
    }
  }

  return { linkedCount: relatedNotes.length };
}
