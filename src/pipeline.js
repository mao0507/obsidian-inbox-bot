import { findUrls, fetchUrlContent } from "./extractContent.js";
import { classifyAndDraft } from "./classify.js";
import { writeNote } from "./writeNote.js";
import { commitAndPush } from "./gitSync.js";
import { syncImagesToEagle } from "./eagleSync.js";
import { archiveImagesToGit } from "./eagleImageArchive.js";
import { embedImagesInVault } from "./imageEmbed.js";
import { EAGLE_ENABLED, EAGLE_GIT_ENABLED } from "./config.js";

/**
 * 統一的處理流程：
 * 文字/網址 -> 抓取（含文中圖片） -> AI 分類整理
 * -> 圖片同步到 Eagle App（如果有設定 EAGLE_ENABLED）
 * -> 圖片備份到獨立的 git repo（如果有設定 EAGLE_GIT_REMOTE，這兩個 Eagle 相關步驟互相獨立、可以只開一個）
 * -> 圖片直接下載進 vault 同一個資料夾、用 ![[檔名]] 內嵌進筆記正文（只要上面兩個 Eagle 功能有開任一個就會做）
 * -> 寫入 vault（附上內嵌圖片 + Eagle 連結） -> vault 筆記同步到 git（如果有設定 VAULT_GIT_REMOTE）
 * Web UI 和 Telegram bot 都呼叫這個函式，確保行為一致。
 */
export async function processIncomingContent(rawText, sourceChannel) {
  const text = (rawText || "").trim();
  if (!text) {
    throw new Error("內容是空的");
  }

  const urls = findUrls(text);
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

  // 沒設定 VAULT_GIT_REMOTE 時這裡會直接回傳 { attempted: false }，不影響任何行為、
  // 也不會拖慢回覆（git 沒啟用的話幾乎是零成本）。有設定的話會 commit + push，
  // 任何失敗都在 gitSync.js 內部處理掉，不會讓筆記寫入這件事被視為失敗。
  const gitResult = await commitAndPush(`新增筆記：${draft.title}（${draft.folder}）`);

  return { draft, result, gitResult, eagleResult, eagleGitResult, embedResult };
}
