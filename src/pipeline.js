import path from "node:path";
import { findUrls } from "./extractContent.js";
import { findDuplicateNote } from "./duplicateCheck.js";
import { syncRelatedNotes } from "./relatedNotes.js";
import { syncMocForFolder } from "./mocSync.js";
import { createNoteDrafter } from "./noteDrafter.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { describeExistingFolders } from "./vaultScan.js";
import { TAXONOMY, INBOX_FALLBACK, buildFolder } from "./taxonomy.js";
import { createTagVocabulary } from "./tagVocabulary.js";
import { planCards, renderCardSection, writeCards } from "./conceptCards.js";

const MAX_URLS_PER_MESSAGE = 3;

/**
 * Pipeline module：一般收件與 /notebook 研究的完整流程，依賴全部由外部注入
 * （正式環境的接線在 app.js；測試用暫存 vault + 假的 ai / fetcher / notebook / git）。
 *
 * @param {object} deps
 * @param {ReturnType<import("./noteStore.js").createNoteStore>} deps.vault
 * @param {{ name: string, ask: Function, askJson: Function }} deps.ai  aiBackends.js 的任一 adapter
 * @param {{ fetch: (url: string) => Promise<object> }} deps.fetcher  網址 -> Source
 * @param {{ researchTopic: Function }} deps.notebook
 * @param {{ commitAndPush: (message: string) => Promise<object> }} deps.git
 */
export function createPipeline({ vault, ai, fetcher, notebook, git }) {
  /**
   * 筆記寫進 vault 之後的共用收尾步驟：
   * -> 跟相關的既有筆記互相補上雙向 [[wikilink]]
   * -> 重新產生該大項目的 <大項目>地圖.md 索引
   * -> vault 筆記同步到 git（放最後，前兩步異動的檔案會一起被這次 commit 帶上去）
   * 任何一步失敗都不影響筆記本身已經寫入這件事，錯誤只印在終端機、回傳的狀態物件會反映失敗。
   */
  async function finalizeWrittenNote(draft, result) {
    let relatedResult = { linkedCount: 0 };
    let mocResult = { updated: false };
    try {
      relatedResult = syncRelatedNotes(vault, {
        folder: draft.folder,
        filename: path.basename(result.relativePath),
        tags: draft.tags,
      });
    } catch (err) {
      console.warn(`[related-notes] 補關聯連結失敗：${err.message}`);
    }
    try {
      mocResult = syncMocForFolder(vault, draft.folder);
    } catch (err) {
      console.warn(`[moc-sync] 更新分類地圖失敗：${err.message}`);
    }

    let gitResult;
    try {
      gitResult = await git.commitAndPush(`新增筆記：${draft.title}（${draft.folder}）`);
    } catch (err) {
      gitResult = { attempted: true, pushed: false, error: err.message };
    }
    return { gitResult, relatedResult, mocResult };
  }

  // type 由流程決定，不交給 AI 判斷；原文標題/作者/日期優先用 fetcher 從網頁 metadata 拿到的，
  // 拿不到才用 AI 從內文找到的（AI 被要求看不出來就留空，不要猜）。
  // fetcher 的降級說明（例如影片沒有字幕）放在筆記最上方，回顧時一眼看得出這篇資訊不完整。
  // 分類：tag 一律經過詞彙表正規化（同一個東西不同寫法 → 同一個資料夾），資料夾由分類樹組出；
  // 大/中項目不在分類樹裡就退回收件匣。收件匣不分 tag 資料夾，也不為它建立主 tag。
  function classify(draft, vocab) {
    const needsTagFolder = !TAXONOMY[draft.category]?.noTagLevel;
    const primary = needsTagFolder ? vocab.resolve([draft.primary_tag]) : { tags: [], created: [] };
    const others = vocab.resolve(draft.tags);
    const primaryTag = primary.tags[0] || "";
    let folder = buildFolder({ category: draft.category, subcategory: draft.subcategory, primaryTag });
    if (!folder) {
      console.warn(`[classifier] AI 的分類「${draft.category}/${draft.subcategory}/${draft.primary_tag}」不在分類樹裡，改放進 ${INBOX_FALLBACK}`);
      folder = INBOX_FALLBACK;
    }
    return {
      folder,
      primaryTag,
      tags: [...new Set([primaryTag, ...others.tags].filter(Boolean))],
      createdTags: [...primary.created, ...others.created],
    };
  }

  async function draftAndSave({ rawText, fetched, sources, sourceChannel, type }) {
    // 每篇重新讀一次詞彙表與既有資料夾：使用者可能手動改過 tags.json 或搬過筆記。
    const vocab = createTagVocabulary(vault);
    const drafter = createNoteDrafter({
      backend: ai,
      buildPrompts: (input) => ({
        system: buildSystemPrompt(input.sourceChannel, {
          existingFolders: describeExistingFolders(vault),
          tags: vocab.list(),
        }),
        user: buildUserPrompt(input),
      }),
    });
    const draft = await drafter.draftNote({ rawText, fetched, sourceChannel });
    const { folder, primaryTag, tags, createdTags } = classify(draft, vocab);
    const cardPlan = planCards(vault, vocab, draft.concepts);
    const source = fetched.find((f) => f.ok) || {};
    const warnings = fetched.map((f) => f.warning).filter(Boolean);
    const note = {
      ...draft,
      folder,
      primary_tag: primaryTag,
      tags,
      type,
      original_title: source.title || draft.original_title,
      author: source.byline || draft.author,
      published: source.published || draft.published,
      channel: source.channel,
      duration: source.duration,
      body: [...warnings.map((w) => `> [!warning] ${w}`), draft.body, renderCardSection(cardPlan)]
        .filter(Boolean)
        .join("\n\n"),
      cards: cardPlan.map((card) => card.name),
      sources,
      sourceChannel,
    };
    const result = vault.writeNote(note);
    let cards = [];
    try {
      writeCards(vault, cardPlan, { notePath: result.relativePath });
      cards = cardPlan.map((card) => ({ name: card.name, created: !card.exists }));
    } catch (err) {
      console.warn(`[cards] 寫入概念卡失敗：${err.message}`);
    }
    return { draft: note, result, warnings, createdTags, cards, ...(await finalizeWrittenNote(note, result)) };
  }

  return {
    /**
     * 文字/網址 -> 來源網址去重比對（同一篇文章丟過就直接回報既有筆記，不重複建立、也不浪費 AI 呼叫）
     * -> 抓取 -> AI 分類整理 -> 寫入 vault -> 收尾
     */
    async processIncomingContent(rawText, sourceChannel) {
      const text = (rawText || "").trim();
      if (!text) throw new Error("內容是空的");

      const urls = findUrls(text);
      const duplicatePath = urls.length ? findDuplicateNote(vault, urls) : null;
      if (duplicatePath) return { duplicate: true, duplicatePath, urls };

      const fetched = [];
      for (const url of urls.slice(0, MAX_URLS_PER_MESSAGE)) {
        // eslint-disable-next-line no-await-in-loop
        fetched.push(await fetcher.fetch(url));
      }

      const type = fetched.some((f) => f.kind === "video") ? "video" : urls.length ? "article" : "note";
      const saved = await draftAndSave({ rawText: text, fetched, sources: urls, sourceChannel, type });
      // 抓不到的網址照樣建立筆記（只靠網址與使用者留言整理），但要讓使用者知道原因
      const fetchErrors = fetched.filter((f) => !f.ok).map(({ url, error }) => ({ url, error }));
      return { ...saved, fetchErrors };
    },

    /**
     * 主題 -> NotebookLM 研究產生報告 -> 交給同一套 AI 分類邏輯整理成筆記 -> 寫入 vault -> 收尾
     */
    async processNotebookResearch(topic, sourceChannel, { onStatus } = {}) {
      const cleanTopic = (topic || "").trim();
      if (!cleanTopic) throw new Error("研究主題是空的");

      const { notebookId, reportText, effectiveTopic } = await notebook.researchTopic(cleanTopic, { onStatus });

      // effectiveTopic 只有在使用者丟網址、且 NotebookLM 讀懂了來源內容時才會跟原始輸入不同，
      // 兩者不同時都給分類 AI 看，分類判斷跟筆記標題會更準確。
      const topicLine =
        effectiveTopic && effectiveTopic !== cleanTopic
          ? `研究主題：${effectiveTopic}（使用者原始輸入：${cleanTopic}）`
          : `研究主題：${cleanTopic}`;

      const rawText =
        `${topicLine}\n\n` +
        `以下是用 NotebookLM 針對這個主題做研究後產生的報告（NotebookLM notebook id: ${notebookId}，內容已含引用來源）：\n\n` +
        reportText;

      const saved = await draftAndSave({ rawText, fetched: [], sources: [], sourceChannel, type: "research" });
      return { notebookId, ...saved };
    },
  };
}
