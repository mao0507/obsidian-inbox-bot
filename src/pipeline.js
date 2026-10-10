import path from "node:path";
import { findUrls } from "./extractContent.js";
import { findDuplicateNote, normalizeUrl } from "./duplicateCheck.js";
import { syncRelatedNotes } from "./relatedNotes.js";
import { syncMocForFolder } from "./mocSync.js";
import { createNoteDrafter } from "./noteDrafter.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { describeExistingFolders } from "./vaultScan.js";
import { TAXONOMY, INBOX_FALLBACK, buildFolder } from "./taxonomy.js";
import { createTagVocabulary } from "./tagVocabulary.js";
import { planCards, renderCardSection, writeCards } from "./conceptCards.js";
import { RESEARCH_PLAN_TOOL, buildPlanPrompts, validatePlan, researchNotesIn, notebookIdOf } from "./researchPlan.js";

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
  // skipGit：批次作業（舊筆記重建）每篇不各自 commit，最後一次 commit。
  async function finalizeWrittenNote(draft, result, { skipGit = false } = {}) {
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

    let gitResult = { attempted: false };
    if (!skipGit) {
      try {
        gitResult = await git.commitAndPush(`新增筆記：${draft.title}（${draft.folder}）`);
      } catch (err) {
        gitResult = { attempted: true, pushed: false, error: err.message };
      }
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

  // extra：流程特有的 frontmatter（例如研究的 topic / notebook_id）；appendix：接在正文最後的區塊。
  // targetPath：改寫既有筆記（補充研究）時給，筆記留在原路徑、檔名不變，其他筆記的連結不會斷。
  async function draftAndSave({
    rawText,
    fetched,
    sources,
    sourceChannel,
    type,
    extra = {},
    appendix = "",
    targetPath,
    skipGit = false,
  }) {
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
      folder: targetPath ? targetPath.slice(0, targetPath.lastIndexOf("/")) : folder,
      primary_tag: primaryTag,
      tags,
      type,
      original_title: source.title || draft.original_title,
      author: source.byline || draft.author,
      published: source.published || draft.published,
      channel: source.channel,
      duration: source.duration,
      body: [...warnings.map((w) => `> [!warning] ${w}`), draft.body, renderCardSection(cardPlan), appendix]
        .filter(Boolean)
        .join("\n\n"),
      cards: cardPlan.map((card) => card.name),
      sources,
      sourceChannel,
      ...extra,
    };
    const result = targetPath ? vault.overwriteNote(targetPath, note) : vault.writeNote(note);
    let cards = [];
    try {
      writeCards(vault, cardPlan, { notePath: result.relativePath });
      cards = cardPlan.map((card) => ({ name: card.name, created: !card.exists }));
    } catch (err) {
      console.warn(`[cards] 寫入概念卡失敗：${err.message}`);
    }
    return { draft: note, result, warnings, createdTags, cards, ...(await finalizeWrittenNote(note, result, { skipGit })) };
  }

  // 研究報告 -> 精讀筆記：依研究角度分章節、不壓縮；完整原始報告摺疊附在文末，方便查證。
  function saveResearchNote({ userInput, question, angles = [], notebookId, reportText, sourceChannel, targetPath }) {
    const angleBlock = angles.length ? `研究角度：\n${angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n` : "";
    const rawText =
      `研究問題：${question}（使用者原始輸入：${userInput}）\n\n${angleBlock}` +
      `以下是用 NotebookLM 研究後產生的報告（notebook id: ${notebookId}，內容含引用來源）。` +
      "整理成精讀筆記時，content 依研究角度分章節，完整保留報告的所有內容、數據與案例，" +
      "保留引用標記與來源清單，不要壓縮成摘要：\n\n" +
      reportText;
    const quotedReport = reportText
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return draftAndSave({
      rawText,
      fetched: [],
      sources: [],
      sourceChannel,
      type: "research",
      extra: { topic: question, notebook_id: notebookId },
      appendix: `> [!note]- 原始研究報告（NotebookLM）\n${quotedReport}`,
      targetPath,
    });
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
     * 舊筆記重建（見 migration.js）：一組舊筆記（同一個來源網址的會合併成一組）用新流程重新產生一篇。
     * 重新抓原文；原文抓不到（或本來就沒有網址）時，原筆記內容就是唯一來源。
     * 保留最早的收錄日期與原本的收件管道；不各自 commit（批次結束時一次 commit）。
     */
    async rebuildNote(oldNotes) {
      const urls = [];
      for (const url of oldNotes.flatMap((n) => n.sources)) {
        if (!urls.some((u) => normalizeUrl(u) === normalizeUrl(url))) urls.push(url);
      }
      const fetched = [];
      for (const url of urls.slice(0, MAX_URLS_PER_MESSAGE)) {
        // eslint-disable-next-line no-await-in-loop
        fetched.push(await fetcher.fetch(url));
      }
      const titles = [...new Set(oldNotes.map((n) => n.title).filter(Boolean))].join("／");
      const rawText = fetched.some((f) => f.ok)
        ? `重新整理既有筆記（原標題：${titles}）。請以擷取到的原文為準，重新整理成精讀筆記。`
        : `重新整理既有筆記（原標題：${titles}）。原文已無法取得，以下原筆記內容是唯一來源，完整保留其中所有資訊：\n\n` +
          oldNotes.map((n) => n.body).join("\n\n---\n\n");
      const dates = oldNotes.map((n) => n.frontmatter.date_added).filter(Boolean).sort();

      const saved = await draftAndSave({
        rawText,
        fetched,
        sources: urls,
        sourceChannel: oldNotes[0].frontmatter.via || "migration",
        type: fetched.some((f) => f.kind === "video") ? "video" : urls.length ? "article" : "note",
        extra: dates.length ? { date_added: dates[0] } : {},
        skipGit: true,
      });
      return { ...saved, fetchErrors: fetched.filter((f) => !f.ok).map(({ url, error }) => ({ url, error })) };
    },

    /**
     * /notebook 送出後、真正開始研究前：把需求整理成「研究問題 + 研究角度」給使用者確認。
     * 需求裡有網址時先抓網址內容當參考；previous + feedback 是使用者要求修改時的上一版計畫與修改意見。
     * vault 裡已經有同主題的研究時，plan.existing = { path, title, notebookId }（讓使用者選補充或新建）。
     */
    async planResearch(topic, { previous, feedback } = {}) {
      const cleanTopic = (topic || "").trim();
      if (!cleanTopic) throw new Error("研究主題是空的");
      const sources = [];
      for (const url of findUrls(cleanTopic).slice(0, MAX_URLS_PER_MESSAGE)) {
        // eslint-disable-next-line no-await-in-loop
        sources.push(await fetcher.fetch(url));
      }
      // 只列找得到 notebook id 的研究：找不到就沒辦法「補充」到同一個 notebook
      const existingResearch = researchNotesIn(vault).filter((r) => r.notebookId);
      const { system, user } = buildPlanPrompts({ topic: cleanTopic, sources, previous, feedback, existingResearch });
      const raw = await ai.askJson({ system, user, tool: RESEARCH_PLAN_TOOL });
      const plan = validatePlan(raw);
      const match = existingResearch.find((r) => r.path === raw.existing_match);
      return match ? { ...plan, existing: { path: match.path, title: match.title, notebookId: match.notebookId } } : plan;
    },

    /**
     * 主題（+ 使用者確認過的研究計畫）-> NotebookLM 研究產生報告 -> 整理成精讀筆記 -> 寫入 vault -> 收尾。
     */
    async processNotebookResearch(topic, sourceChannel, { plan, onStatus } = {}) {
      const cleanTopic = (topic || "").trim();
      if (!cleanTopic) throw new Error("研究主題是空的");

      const { notebookId, reportText, effectiveTopic } = await notebook.researchTopic(cleanTopic, { plan, onStatus });
      const saved = await saveResearchNote({
        userInput: cleanTopic,
        question: plan?.question || effectiveTopic || cleanTopic,
        angles: plan?.angles,
        notebookId,
        reportText,
        sourceChannel,
      });
      return { notebookId, ...saved };
    },

    /**
     * 補充既有研究：在原本的 notebook 上依新計畫加跑 deep research、重新產生報告，
     * 再用新報告改寫原筆記（路徑與檔名不變，連結不會斷；notebook id 不變）。
     */
    async supplementResearch(notePath, sourceChannel, { plan, onStatus } = {}) {
      const existing = vault.readNote(notePath);
      const notebookId = notebookIdOf(existing);
      if (!notebookId) throw new Error(`「${notePath}」找不到 NotebookLM notebook id，沒辦法補充，請改用「另外新建」`);

      const { reportText } = await notebook.supplementResearch(notebookId, plan, { onStatus });
      const saved = await saveResearchNote({
        userInput: existing.frontmatter.topic || existing.title,
        question: plan.question,
        angles: plan.angles,
        notebookId,
        reportText,
        sourceChannel,
        targetPath: notePath,
      });
      return { notebookId, ...saved };
    },
  };
}
