import { CLASSIFIER_MODE } from "./config.js";
import { classifyViaApi } from "./classifyViaApi.js";
import { classifyViaCli } from "./classifyViaCli.js";

/**
 * @param {object} input
 * @param {string} input.rawText 使用者原始輸入的文字（可能包含網址、留言、想法）
 * @param {Array<{url:string, ok:boolean, title?:string, text?:string, error?:string}>} input.fetched 已抓取的網址內容
 * @param {string} input.sourceChannel "web" | "telegram"
 *
 * 依 config.js 判斷出的 CLASSIFIER_MODE 分派給 API 版或 CLI 版，
 * 兩邊回傳的物件形狀完全一致，呼叫端（pipeline.js）不用管實際是哪個在跑。
 */
export async function classifyAndDraft({ rawText, fetched = [], sourceChannel }) {
  if (CLASSIFIER_MODE === "cli") {
    return classifyViaCli({ rawText, fetched, sourceChannel });
  }
  return classifyViaApi({ rawText, fetched, sourceChannel });
}
