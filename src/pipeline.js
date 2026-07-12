import { findUrls, fetchUrlContent } from "./extractContent.js";
import { classifyAndDraft } from "./classify.js";
import { writeNote } from "./writeNote.js";

/**
 * 統一的處理流程：文字/網址 -> 抓取 -> AI 分類整理 -> 寫入 vault
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

  const result = writeNote({
    ...draft,
    sources: urls,
    sourceChannel,
  });

  return { draft, result };
}
