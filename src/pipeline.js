import path from "node:path";
import { findUrls, fetchUrlContent } from "./extractContent.js";
import { classifyAndDraft } from "./classify.js";
import { writeNote } from "./writeNote.js";
import { commitAndPush } from "./gitSync.js";
import { syncImagesToEagle } from "./eagleSync.js";
import { archiveImagesToGit } from "./eagleImageArchive.js";
import { embedImagesInVault } from "./imageEmbed.js";
import { findDuplicateNote } from "./duplicateCheck.js";
import { syncRelatedNotes } from "./relatedNotes.js";
import { syncMocForFolder } from "./mocSync.js";
import { EAGLE_ENABLED, EAGLE_GIT_ENABLED } from "./config.js";

/**
 * 統一的處理流程：
 * 文字/網址 -> 來源網址去重比對（同一篇文章丟過就直接回報既有筆記，不重複建立）
 * -> 抓取（含文中圖片） -> AI 分類整理
 * -> 圖片同步到 Eagle App（如果有設定 EAGLE_ENABLED）
 * -> 圖片備份到獨立的 git repo（如果有設定 EAGLE_GIT_REMOTE，這兩個 Eagle 相關步驟互相獨立、可以只開一個）
 * -> 圖片直接下載進 vault 同一個資料夾、用 ![[檔名]] 內嵌進筆記正文（只要上面兩個 Eagle 功能有開任一個就會做）
 * -> 寫入 vault（附上內嵌圖片 + Eagle 連結）
 * -> 跟同資料夾/同標籤的既有筆記互相補上雙向 [[wikilink]]（見 relatedNotes.js）
 * -> 動態分類（AI、學習、旅遊）額外重新產生一份 <分類>地圖.md 索引（見 mocSync.js）
 * -> vault 筆記同步到 git（如果有設定 VAULT_GIT_REMOTE）
 * Web UI 和 Telegram bot 都呼叫這個函式，確保行為一致。
 */
export async function processIncomingContent(rawText, sourceChannel) {
  const text = (rawText || "").trim();
  if (!text) {
    throw new Error("內容是空的");
  }

  const urls = findUrls(text);

  // 分類之前先比對來源網址，vault 裡已經有同一篇文章的筆記就直接回報，
  // 不浪費一次 AI 呼叫、也不會生出內容重複的筆記（見 duplicateCheck.js 的說明）。
  const duplicatePath = urls.length ? findDuplicateNote(urls) : null;
  if (duplicatePath) {
    return { duplicate: true, duplicatePath, urls };
  }

  const fetched = [];
  for (const url of urls.slice(0, 3)) {
    // eslint-disable-next-line no-await-in-loop
    fetched.push(await fetchUrlContent(url));
  }

  const draft = await classifyAndDraft({ rawText: text, fetched, sourceChannel });

  // 把所有抓到的來源網頁裡的圖片網址攤平、去重。
  const images = [...new Set(fetched.flatMap((f) => (f.ok ? f.images || [] : [])))];

  // 三條圖片相關的路徑互相獨立，沒開/沒圖片的會直接回傳 { attempted:false }：
  // 1. syncImagesToEagle：呼叫 Eagle App 本機 API，把圖片交給 Eagle 下載、建資料夾
  // 2. archiveImagesToGit：自己下載圖片位元組、存到本機資料夾，commit + push 到你自己的 git repo
  // 3. embedImagesInVault：把圖片直接下載進 vault 筆記所在的資料夾，讓筆記能用 ![[檔名]] 內嵌顯示
  //    （只要 Eagle 相關功能有開一個就會做，避免沒用 Eagle 的人也被迫下載圖片進 vault）
  const embedEnabled = EAGLE_ENABLED || EAGLE_GIT_ENABLED;
  const [eagleResult, eagleGitResult, embedResult] = await Promise.all([
    syncImagesToEagle({
      images,
      folder: draft.folder,
      title: draft.title,
      tags: draft.tags,
      sourceUrl: urls[0],
    }),
    archiveImagesToGit({
      images,
      folder: draft.folder,
      title: draft.title,
    }),
    embedEnabled ? embedImagesInVault({ folder: draft.folder, images, title: draft.title }) : Promise.resolve({ filenames: [], failed: 0 }),
  ]);

  const result = writeNote({
    ...draft,
    sources: urls,
    sourceChannel,
    embeddedImageFilenames: embedResult?.filenames || [],
    eagleImages: eagleResult?.links || [],
  });

  // 筆記寫進去之後，跟同資料夾（動態分類）或同標籤（扁平分類）的既有筆記互相補上
  // 雙向 [[wikilink]]，並且動態分類再重新產生一份 <分類>地圖.md 索引。
  // 失敗不影響筆記本身已經寫入這件事，錯誤只印在終端機。
  let relatedResult = { linkedCount: 0 };
  let mocResult = { updated: false };
  try {
    relatedResult = syncRelatedNotes({ folder: draft.folder, filename: path.basename(result.relativePath), tags: draft.tags });
  } catch (err) {
    console.warn(`[related-notes] 補關聯連結失敗：${err.message}`);
  }
  try {
    mocResult = syncMocForFolder(draft.folder);
  } catch (err) {
    console.warn(`[moc-sync] 更新分類地圖失敗：${err.message}`);
  }

  // 沒設定 VAULT_GIT_REMOTE 時這裡會直接回傳 { attempted: false }，不影響任何行為、
  // 也不會拖慢回覆（git 沒啟用的話幾乎是零成本）。有設定的話會 commit + push，
  // 任何失敗都在 gitSync.js 內部處理掉，不會讓筆記寫入這件事被視為失敗。
  // （放在 relatedNotes/mocSync 之後，這樣它們異動的檔案會一起被這次 commit 帶上去。）
  const gitResult = await commitAndPush(`新增筆記：${draft.title}（${draft.folder}）`);

  return { draft, result, gitResult, eagleResult, eagleGitResult, embedResult, relatedResult, mocResult };
}
