import { findUrls, fetchUrlContent } from "./extractContent.js";
import { classifyAndDraft } from "./classify.js";
import { writeNote } from "./writeNote.js";
import { commitAndPush } from "./gitSync.js";
import { syncImagesToEagle } from "./eagleSync.js";

/**
 * 統一的處理流程：
 * 文字/網址 -> 抓取（含文中圖片） -> AI 分類整理 -> 圖片同步到 Eagle（如果有設定）
 * -> 寫入 vault（附上 Eagle 連結） -> 同步到 git（如果有設定）
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

  // 把所有抓到的來源網頁裡的圖片網址攤平、去重，交給 Eagle 匯入。
  // 沒設定 EAGLE_ENABLED 或完全沒有圖片時，syncImagesToEagle 會直接回傳 { attempted:false }。
  const images = [...new Set(fetched.flatMap((f) => (f.ok ? f.images || [] : [])))];
  const eagleResult = await syncImagesToEagle({
    images,
    folder: draft.folder,
    title: draft.title,
    tags: draft.tags,
    sourceUrl: urls[0],
  });

  const result = writeNote({
    ...draft,
    sources: urls,
    sourceChannel,
    eagleImages: eagleResult?.links || [],
  });

  // 沒設定 VAULT_GIT_REMOTE 時這裡會直接回傳 { attempted: false }，不影響任何行為、
  // 也不會拖慢回覆（git 沒啟用的話幾乎是零成本）。有設定的話會 commit + push，
  // 任何失敗都在 gitSync.js 內部處理掉，不會讓筆記寫入這件事被視為失敗。
  const gitResult = await commitAndPush(`新增筆記：${draft.title}（${draft.folder}）`);

  return { draft, result, gitResult, eagleResult };
}
