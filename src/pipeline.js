import path from "node:path";
import { findUrls, fetchUrlContent } from "./extractContent.js";
import { classifyAndDraft } from "./classify.js";
import { writeNote } from "./writeNote.js";
import { commitAndPush } from "./gitSync.js";
import { findDuplicateNote } from "./duplicateCheck.js";
import { syncRelatedNotes } from "./relatedNotes.js";
import { syncMocForFolder } from "./mocSync.js";
import { researchTopic } from "./notebookResearch.js";

/**
 * 筆記寫進 vault 之後的共用收尾步驟，processIncomingContent（一般丟內容）跟
 * processNotebookResearch（/notebook 研究）都會呼叫這個：
 * -> 跟同資料夾（動態分類）或同標籤（扁平分類）的既有筆記互相補上雙向 [[wikilink]]
 * -> 動態分類（AI、學習、旅遊）額外重新產生一份 <分類>地圖.md 索引
 * -> vault 筆記同步到 git（如果有設定 VAULT_GIT_REMOTE）
 * 任何一步失敗都不影響筆記本身已經寫入這件事，錯誤只印在終端機、回傳的狀態物件會反映失敗。
 */
async function finalizeWrittenNote(draft, result) {
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

  return { gitResult, relatedResult, mocResult };
}

/**
 * 統一的處理流程：
 * 文字/網址 -> 來源網址去重比對（同一篇文章丟過就直接回報既有筆記，不重複建立）
 * -> 抓取 -> AI 分類整理 -> 寫入 vault -> finalizeWrittenNote 收尾
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

  const result = writeNote({
    ...draft,
    sources: urls,
    sourceChannel,
  });

  const { gitResult, relatedResult, mocResult } = await finalizeWrittenNote(draft, result);

  return { draft, result, gitResult, relatedResult, mocResult };
}

/**
 * /notebook 指令的處理流程：
 * 主題 -> 呼叫 notebookResearch.js 用 NotebookLM 做研究、產生報告
 * -> 把報告內容交給既有的 AI 分類邏輯（決定資料夾/標籤/摘要，並整理成筆記正文，
 *    跟一般丟內容進來的筆記走同一套分類規則、同一份 taxonomy）
 * -> 寫入 vault -> finalizeWrittenNote 收尾（關聯連結、分類地圖、git 同步）
 */
export async function processNotebookResearch(topic, sourceChannel) {
  const cleanTopic = (topic || "").trim();
  if (!cleanTopic) {
    throw new Error("研究主題是空的");
  }

  const { notebookId, reportText, effectiveTopic } = await researchTopic(cleanTopic);

  // effectiveTopic 通常跟 cleanTopic 一樣；只有當使用者丟的是網址（例如 YouTube 連結）
  // 且 notebookResearch.js 成功理解了來源內容時，才會換成「這個來源實際在講什麼」的
  // 描述（見 notebookResearch.js 的 describeSource）。兩者不同時兩行都給分類 AI 看，
  // 讓它同時知道「實際主題」跟「使用者原始輸入」，分類判斷跟筆記標題會更準確。
  const topicLine =
    effectiveTopic && effectiveTopic !== cleanTopic
      ? `研究主題：${effectiveTopic}（使用者原始輸入：${cleanTopic}）`
      : `研究主題：${cleanTopic}`;

  const rawText =
    `${topicLine}\n\n` +
    `以下是用 NotebookLM 針對這個主題做研究後產生的報告（NotebookLM notebook id: ${notebookId}，內容已含引用來源）：\n\n` +
    reportText;

  const draft = await classifyAndDraft({ rawText, fetched: [], sourceChannel });

  const result = writeNote({
    ...draft,
    sources: [],
    sourceChannel,
  });

  const { gitResult, relatedResult, mocResult } = await finalizeWrittenNote(draft, result);

  return { notebookId, draft, result, gitResult, relatedResult, mocResult };
}
