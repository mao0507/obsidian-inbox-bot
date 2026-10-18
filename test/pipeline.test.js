import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createPipeline } from "../src/pipeline.js";

const draft = {
  category: "技術",
  subcategory: "DevOps與部署",
  primary_tag: "Docker",
  title: "Docker 健康檢查",
  tags: ["Compose"],
  summary: "healthcheck 寫法",
  kind: "片段",
  tldr: "用 healthcheck 讓 compose 知道服務活著",
  key_points: ["interval 30s"],
  content: "### 寫法\n內文",
  review_questions: [{ question: "Q", answer: "A" }],
  author: "AI 猜的作者",
  published: "",
  original_title: "",
};

// 假依賴：每個 test 拿一組新的，calls 記錄被呼叫的情形。
function pipelineDeps(vault) {
  return {
    vault,
    ai: { name: "fake", ask: async () => "", askJson: async () => draft },
    fetcher: { fetch: async (url) => ({ url, ok: false, error: "x" }) },
    git: { commitAndPush: async () => ({ attempted: false }) },
  };
}

function setup(options = {}) {
  return setupWith(createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-"))), options);
}

function setupWith(vault, { aiDraft = draft, plan, fetched = {}, gitResult = { attempted: false }, report } = {}) {
  const calls = { askJson: [], fetch: [], git: [], research: [] };
  const ai = {
    name: "fake",
    ask: async () => "",
    askJson: async (input) => {
      calls.askJson.push(input);
      return input.tool.name === "research_plan" ? plan : aiDraft;
    },
  };
  const fetcher = {
    fetch: async (url) => {
      calls.fetch.push(url);
      return fetched[url] || { url, ok: false, error: "not found" };
    },
  };
  const git = {
    commitAndPush: async (message) => {
      calls.git.push(message);
      if (gitResult instanceof Error) throw gitResult;
      return gitResult;
    },
  };
  const notebook = {
    researchTopic: async (topic, options) => {
      calls.research.push(topic);
      calls.researchOptions = options;
      return report;
    },
  };
  return { vault, calls, pipeline: createPipeline({ vault, ai, fetcher, notebook, git }) };
}

test("plain text: drafts, writes to vault, then commits", async () => {
  const { vault, calls, pipeline } = setup();

  const out = await pipeline.processIncomingContent("記一下 docker healthcheck", "telegram");

  assert.equal(out.result.relativePath, "技術/DevOps與部署/Docker/Docker 健康檢查.md");
  assert.equal(vault.readNote(out.result.relativePath).title, "Docker 健康檢查");
  assert.equal(calls.fetch.length, 0);
  assert.deepEqual(calls.git, ["新增筆記：Docker 健康檢查（技術/DevOps與部署/Docker）"]);
});

test("url: fetched content reaches the AI prompt and source lands in frontmatter", async () => {
  const url = "https://example.com/post";
  const { vault, calls, pipeline } = setup({
    fetched: { [url]: { url, ok: true, title: "原文標題", text: "原文全文 ABC", byline: "", excerpt: "" } },
  });

  const out = await pipeline.processIncomingContent(`看這篇 ${url}`, "telegram");

  assert.deepEqual(calls.fetch, [url]);
  assert.match(calls.askJson[0].user, /原文全文 ABC/);
  assert.deepEqual(vault.readNote(out.result.relativePath).sources, [url]);
});

test("url already in vault: reports duplicate without calling AI", async () => {
  const { vault, calls, pipeline } = setup();
  vault.writeNote({ ...draft, folder: "技術/DevOps與部署/Docker", body: "內文", sources: ["https://example.com/post"], sourceChannel: "telegram" });

  const out = await pipeline.processIncomingContent("https://example.com/post?utm_source=x", "telegram");

  assert.equal(out.duplicate, true);
  assert.equal(out.duplicatePath, "技術/DevOps與部署/Docker/Docker 健康檢查.md");
  assert.equal(calls.askJson.length, 0);
});

test("category outside the taxonomy falls back to inbox", async () => {
  const { pipeline } = setup({ aiDraft: { ...draft, category: "知識庫" } });
  const out = await pipeline.processIncomingContent("隨便 測試內容", "telegram");
  assert.equal(out.draft.folder, "收件匣/待整理");
});

test("git failure does not fail the note", async () => {
  const { vault, pipeline } = setup({ gitResult: { attempted: true, pushed: false, error: "boom" } });
  const out = await pipeline.processIncomingContent("記一下 測試內容", "telegram");
  assert.equal(out.gitResult.error, "boom");
  assert.ok(vault.readNote(out.result.relativePath));
});

test("empty input is rejected", async () => {
  const { pipeline } = setup();
  await assert.rejects(pipeline.processIncomingContent("   ", "telegram"), /內容是空的/);
});

test("notebook research: report drives the draft and note is saved", async () => {
  const { vault, calls, pipeline } = setup({
    report: { notebookId: "nb1", reportText: "報告全文 XYZ", effectiveTopic: "量子運算" },
  });

  const out = await pipeline.processNotebookResearch("https://youtu.be/abc", "telegram-notebook");

  assert.deepEqual(calls.research, ["https://youtu.be/abc"]);
  assert.match(calls.askJson[0].user, /研究問題：量子運算（使用者原始輸入：https:\/\/youtu.be\/abc）/);
  assert.match(calls.askJson[0].user, /報告全文 XYZ/);
  assert.equal(out.notebookId, "nb1");
  assert.ok(vault.readNote(out.result.relativePath));
});

test("related links and MOC run after write", async () => {
  const { vault, pipeline } = setup();
  await pipeline.processIncomingContent("a 測試內容", "telegram");
  const out = await pipeline.processIncomingContent("b 測試內容", "telegram");

  assert.equal(out.relatedResult.linkedCount, 1);
  assert.deepEqual(out.mocResult, { updated: true, mocPath: "技術/技術地圖.md" });
  assert.match(vault.readNote(out.result.relativePath).body, /## 相關筆記/);
});

test("note type: plain text is note, fetched url is article, research is research", async () => {
  const url = "https://example.com/post";
  const { vault, pipeline } = setup({
    fetched: { [url]: { url, ok: true, title: "T", text: "x", byline: "", excerpt: "" } },
    report: { notebookId: "nb1", reportText: "r", effectiveTopic: "t" },
  });
  const type = (out) => vault.readNote(out.result.relativePath).frontmatter.type;

  assert.equal(type(await pipeline.processIncomingContent("想法 測試內容", "telegram")), "note");
  assert.equal(type(await pipeline.processIncomingContent(url, "telegram")), "article");
  assert.equal(type(await pipeline.processNotebookResearch("主題", "telegram-notebook")), "research");
});

test("source metadata from the fetcher wins over what the AI guessed", async () => {
  const url = "https://example.com/post";
  const { vault, pipeline } = setup({
    fetched: {
      [url]: { url, ok: true, title: "原文標題", text: "x", byline: "真正作者", excerpt: "", published: "2026-03-04" },
    },
  });
  const fm = vault.readNote((await pipeline.processIncomingContent(url, "telegram")).result.relativePath).frontmatter;
  assert.equal(fm.author, "真正作者");
  assert.equal(fm.published, "2026-03-04");
  assert.equal(fm.original_title, "原文標題");
});

test("note body follows the template and frontmatter has reading_time", async () => {
  const { vault, pipeline } = setup();
  const note = vault.readNote((await pipeline.processIncomingContent("記一下 測試內容", "telegram")).result.relativePath);
  assert.match(note.body, /TL;DR[\s\S]*## 重點[\s\S]*## 詳細內容[\s\S]*## 回顧問題/);
  assert.equal(note.frontmatter.kind, "片段");
  assert.match(note.frontmatter.reading_time, /分鐘$/);
});

test("fetch failures are surfaced in the outcome", async () => {
  const { pipeline } = setup(); // 預設 fetcher 對任何網址都回傳失敗
  const out = await pipeline.processIncomingContent("https://blocked.example/post", "telegram");
  assert.deepEqual(out.fetchErrors, [{ url: "https://blocked.example/post", error: "not found" }]);
});

test("youtube video: type video, channel/duration in frontmatter, timestamp instructions in prompt", async () => {
  const url = "https://youtu.be/vid";
  const { vault, calls, pipeline } = setup({
    fetched: {
      [url]: {
        url,
        ok: true,
        kind: "video",
        title: "影片標題",
        byline: "某頻道",
        channel: "某頻道",
        duration: "12:34",
        published: "2026-03-15",
        text: "逐字稿：\n[00:01](https://youtu.be/vid?t=1) 大家好",
      },
    },
  });

  const out = await pipeline.processIncomingContent(url, "telegram");
  const fm = vault.readNote(out.result.relativePath).frontmatter;

  assert.equal(fm.type, "video");
  assert.equal(fm.channel, "某頻道");
  assert.equal(fm.duration, "12:34");
  assert.match(calls.askJson[0].user, /時間戳/);
});

test("fetcher warnings (e.g. no subtitles) are shown at the top of the note and in the outcome", async () => {
  const url = "https://youtu.be/vid";
  const warning = "這支影片沒有字幕，筆記只依標題與影片說明整理";
  const { vault, pipeline } = setup({
    fetched: { [url]: { url, ok: true, kind: "video", title: "t", text: "影片說明", warning } },
  });

  const out = await pipeline.processIncomingContent(url, "telegram");

  assert.deepEqual(out.warnings, [warning]);
  assert.ok(vault.readNote(out.result.relativePath).body.startsWith(`# Docker 健康檢查\n\n> [!warning] ${warning}`));
});

test("tag spelling variants land in the same folder and frontmatter tags are canonical", async () => {
  const { vault, pipeline } = setup({
    aiDraft: { ...draft, category: "AI", subcategory: "編程助手", primary_tag: "ClaudeCode", tags: ["MCP"] },
  });
  await pipeline.processIncomingContent("a 測試內容", "telegram");

  const variant = { ...draft, category: "AI", subcategory: "編程助手", primary_tag: "Claude Code", tags: ["mcp", "claude-code"] };
  const { pipeline: second } = setupWith(vault, { aiDraft: variant });
  const out = await second.processIncomingContent("b 測試內容", "telegram");

  assert.equal(out.draft.folder, "AI/編程助手/ClaudeCode");
  assert.deepEqual(vault.readNote(out.result.relativePath).tags, ["ClaudeCode", "MCP"]);
  assert.deepEqual(out.createdTags, []);
});

test("brand-new tags are created and reported", async () => {
  const { pipeline } = setup({ aiDraft: { ...draft, primary_tag: "Podman", tags: ["Rootless"] } });
  const out = await pipeline.processIncomingContent("a 測試內容", "telegram");
  assert.equal(out.draft.folder, "技術/DevOps與部署/Podman");
  assert.deepEqual(out.createdTags, ["Podman", "Rootless"]);
});

test("inbox notes have no tag folder", async () => {
  const { pipeline } = setup({ aiDraft: { ...draft, category: "收件匣", subcategory: "靈感", primary_tag: "" } });
  const out = await pipeline.processIncomingContent("突然想到", "telegram");
  assert.equal(out.draft.folder, "收件匣/靈感");
});

const researchPlan = { question: "台灣離岸風電的發展瓶頸", angles: ["政策", "供應鏈", "電網"] };

test("planResearch: asks the AI for a question + angles, with linked page context", async () => {
  const url = "https://example.com/wind";
  const { calls, pipeline } = setup({
    plan: researchPlan,
    fetched: { [url]: { url, ok: true, title: "風電報導", text: "報導內文 QQQ", byline: "", excerpt: "" } },
  });

  const plan = await pipeline.planResearch(`研究這篇 ${url}`);

  assert.deepEqual(plan, researchPlan);
  assert.equal(calls.askJson[0].tool.name, "research_plan");
  assert.match(calls.askJson[0].user, /風電報導[\s\S]*報導內文 QQQ/);
});

test("planResearch: user feedback and the previous plan go into the revision prompt", async () => {
  const { calls, pipeline } = setup({ plan: researchPlan });
  await pipeline.planResearch("離岸風電", { previous: researchPlan, feedback: "多看漁業衝突" });
  assert.match(calls.askJson[0].user, /政策[\s\S]*多看漁業衝突/);
});

test("planResearch: an unusable plan is rejected", async () => {
  const { pipeline } = setup({ plan: { question: "q", angles: [] } });
  await assert.rejects(pipeline.planResearch("x"), /研究角度/);
});

test("research note keeps the plan, topic/notebook_id frontmatter and the full original report", async () => {
  const { vault, calls, pipeline } = setup({
    report: { notebookId: "nb9", reportText: "## 政策\n完整報告內容 [1]", effectiveTopic: researchPlan.question },
  });

  const out = await pipeline.processNotebookResearch("離岸風電", "telegram-notebook", { plan: researchPlan });
  const note = vault.readNote(out.result.relativePath);

  assert.deepEqual(calls.researchOptions.plan, researchPlan);
  assert.match(calls.askJson[0].user, /1\. 政策[\s\S]*不要壓縮/);
  assert.equal(note.frontmatter.topic, researchPlan.question);
  assert.equal(note.frontmatter.notebook_id, "nb9");
  assert.match(note.body, /> \[!note\]- 原始研究報告（NotebookLM）\n> ## 政策\n> 完整報告內容 \[1\]/);
});

function seedResearch(vault, { title, notebookId, oldStyle = false }) {
  const extra = oldStyle ? {} : { topic: title, notebook_id: notebookId };
  const body = oldStyle ? `> 來源：telegram-notebook（NotebookLM notebook id: ${notebookId}）\n\n內容` : "內容";
  return vault.writeNote({
    folder: "AI/編程助手/ClaudeCode",
    title,
    tags: ["ClaudeCode"],
    summary: "s",
    body,
    type: "research",
    sourceChannel: "telegram-notebook",
    ...extra,
  }).relativePath;
}

test("planResearch lists existing research and returns the matched note with its notebook id", async () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const oldPath = seedResearch(vault, {
    title: "grill-me Skill 研究",
    notebookId: "b7c30b9b-cb08-4db3-8752-5e98b6ba38a7",
    oldStyle: true,
  });
  const { calls, pipeline } = setupWith(vault, { plan: { ...researchPlan, existing_match: oldPath } });

  const plan = await pipeline.planResearch("grill me 技能");

  assert.ok(calls.askJson[0].user.includes(oldPath), "existing research is listed in the prompt");
  assert.deepEqual(plan.existing, {
    path: oldPath,
    title: "grill-me Skill 研究",
    notebookId: "b7c30b9b-cb08-4db3-8752-5e98b6ba38a7",
  });
});

test("planResearch ignores a match that is not an existing research note", async () => {
  const { pipeline } = setup({ plan: { ...researchPlan, existing_match: "不存在/的筆記.md" } });
  assert.equal((await pipeline.planResearch("x")).existing, undefined);
});

test("supplementResearch deepens the same notebook and rewrites the same note in place", async () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const notePath = seedResearch(vault, { title: "既有研究", notebookId: "nb-old" });
  const supplemented = [];
  const pipeline = createPipeline({
    ...pipelineDeps(vault),
    notebook: {
      supplementResearch: async (notebookId, plan) => {
        supplemented.push({ notebookId, plan });
        return { notebookId, reportText: "## 新角度\n補充後的完整報告" };
      },
    },
  });

  const notesBefore = vault.listNotes().filter((n) => n.frontmatter.type !== "MOC").length;
  const out = await pipeline.supplementResearch(notePath, "telegram-notebook", { plan: researchPlan });
  const note = vault.readNote(notePath);

  assert.deepEqual(supplemented, [{ notebookId: "nb-old", plan: researchPlan }]);
  assert.equal(out.result.relativePath, notePath);
  assert.equal(vault.listNotes().filter((n) => n.frontmatter.type !== "MOC").length, notesBefore, "no new note file");
  assert.equal(note.frontmatter.notebook_id, "nb-old");
  assert.match(note.body, /補充後的完整報告/);
});

test("rebuildResearchNote: merges notebooks, keeps earliest date, lists every notebook id, no per-note commit", async () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const a = seedResearch(vault, { title: "grill-me 研究一", notebookId: "11111111-1111-1111-1111-111111111111", oldStyle: true });
  const b = seedResearch(vault, { title: "grill-me 研究二", notebookId: "22222222-2222-2222-2222-222222222222", oldStyle: true });
  const notes = [a, b].map((p) => vault.readNote(p));
  notes[1].frontmatter.date_added = "2020-01-01";
  let gitCalls = 0;
  const rebuilt = [];
  const pipeline = createPipeline({
    ...pipelineDeps(vault),
    git: { commitAndPush: async () => (gitCalls++, { attempted: false }) },
    notebook: {
      rebuildResearch: async ({ notebookIds, plan }) => {
        rebuilt.push({ notebookIds, plan });
        return { notebookId: notebookIds[1], mergedFrom: [notebookIds[0]], reportText: "合併後報告" };
      },
    },
  });

  const out = await pipeline.rebuildResearchNote(notes, researchPlan);
  const fm = vault.readNote(out.result.relativePath).frontmatter;

  assert.deepEqual(rebuilt[0].notebookIds, ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]);
  assert.equal(fm.type, "research");
  assert.equal(fm.notebook_id, "22222222-2222-2222-2222-222222222222");
  assert.deepEqual(fm.notebook_ids, ["22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111"]);
  assert.equal(fm.date_added, "2020-01-01");
  assert.equal(gitCalls, 0);
});

test("rebuildResearchNote: all notebooks gone -> researches the plan from scratch", async () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const p = seedResearch(vault, { title: "舊研究", notebookId: "33333333-3333-3333-3333-333333333333", oldStyle: true });
  const researched = [];
  const pipeline = createPipeline({
    ...pipelineDeps(vault),
    notebook: {
      rebuildResearch: async () => null,
      researchTopic: async (topic, options) => (researched.push({ topic, options }), { notebookId: "fresh", reportText: "新報告" }),
    },
  });

  const out = await pipeline.rebuildResearchNote([vault.readNote(p)], researchPlan);

  assert.deepEqual(researched, [{ topic: researchPlan.question, options: { plan: researchPlan } }]);
  assert.equal(vault.readNote(out.result.relativePath).frontmatter.notebook_id, "fresh");
});

test("rebuildResearchNote keeps every old notebook id even when they were all deleted", async () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const oldId = "44444444-4444-4444-4444-444444444444";
  const p = seedResearch(vault, { title: "舊研究", notebookId: oldId, oldStyle: true });
  const pipeline = createPipeline({
    ...pipelineDeps(vault),
    notebook: { rebuildResearch: async () => null, researchTopic: async () => ({ notebookId: "fresh", reportText: "r" }) },
  });

  const out = await pipeline.rebuildResearchNote([vault.readNote(p)], researchPlan);

  assert.deepEqual(vault.readNote(out.result.relativePath).frontmatter.notebook_ids, ["fresh", oldId]);
});

test("a category outside the taxonomy does not add its primary tag to the vocabulary", async () => {
  const { vault, pipeline } = setup({ aiDraft: { ...draft, category: "知識庫", primary_tag: "完全新的Tag" } });
  const out = await pipeline.processIncomingContent("x 測試內容", "telegram");
  assert.equal(out.draft.folder, "收件匣/待整理");
  assert.ok(!(vault.readFile("_系統/tags.json") || "").includes("完全新的Tag"));
  assert.ok(!out.createdTags.includes("完全新的Tag"));
});

test("supplementResearch keeps the user's hand-written related links", async () => {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const notePath = seedResearch(vault, { title: "既有研究", notebookId: "nb-old" });
  vault.updateNote(notePath, (c) => `${c}\n## 相關筆記\n\n- [[我手動加的連結]]\n`);
  const pipeline = createPipeline({
    ...pipelineDeps(vault),
    notebook: { supplementResearch: async (notebookId) => ({ notebookId, reportText: "新報告" }) },
  });

  await pipeline.supplementResearch(notePath, "telegram-notebook", { plan: researchPlan });

  const body = vault.readNote(notePath).body;
  assert.match(body, /\[\[我手動加的連結\]\]/);
  assert.equal(body.split("## 相關筆記").length, 2, "only one related section");
});

test("refreshNote rebuilds a note in place from its source url and commits", async () => {
  const url = "https://example.com/a";
  const { vault, calls, pipeline } = setup({ fetched: { [url]: { url, ok: true, title: "A", text: "原文" } } });
  const old = vault.writeNote({ folder: "技術/前端框架/Vue", title: "舊筆記", tags: ["Vue"], summary: "s", body: "舊內容", sources: [url], type: "article", sourceChannel: "t" }).relativePath;

  const out = await pipeline.refreshNote(old);

  assert.equal(out.result.relativePath, old, "stays at the same path");
  assert.deepEqual(calls.fetch, [url]);
  assert.notEqual(vault.readNote(old).body, "舊內容");
  assert.equal(calls.git.length, 1);
});

test("refreshNote refuses research notes, notes without sources and missing notes", async () => {
  const { vault, pipeline } = setup();
  const research = vault.writeNote({ folder: "技術/x", title: "研究", tags: [], summary: "s", body: "b", sources: ["https://x.com"], type: "research", sourceChannel: "t" }).relativePath;
  const noSource = vault.writeNote({ folder: "技術/x", title: "想法", tags: [], summary: "s", body: "b", type: "note", sourceChannel: "t" }).relativePath;
  await assert.rejects(pipeline.refreshNote(research), /notebook/);
  await assert.rejects(pipeline.refreshNote(noSource), /沒有原始網址/);
  await assert.rejects(pipeline.refreshNote("不存在.md"), /找不到筆記/);
});

test("very short text without a url is rejected before calling the AI", async () => {
  const { calls, pipeline } = setup();
  await assert.rejects(pipeline.processIncomingContent("f", "telegram"), /內容太短/);
  await assert.rejects(pipeline.processIncomingContent("買牛", "telegram"), /內容太短/);
  assert.equal(calls.askJson.length, 0);
  await pipeline.processIncomingContent("買牛奶記得", "telegram"); // 夠長的短想法照常存
  assert.equal(calls.askJson.length, 1);
});

test("provider: page clues reach the AI prompt and the AI's provider lands in frontmatter", async () => {
  const url = "https://www.dtsgroup.com.tw/group/X";
  const { vault, calls, pipeline } = setup({
    aiDraft: { ...draft, provider: "大榮旅遊" },
    fetched: { [url]: { url, ok: true, title: "北海道五日", text: "行程", byline: "", excerpt: "", providerHints: ["大榮旅遊"] } },
  });

  const out = await pipeline.processIncomingContent(url, "telegram");

  assert.match(calls.askJson[0].user, /主辦單位線索：大榮旅遊/);
  assert.match(calls.askJson[0].system, /主辦單位.*不要從網域/);
  assert.equal(vault.readNote(out.result.relativePath).frontmatter.provider, "大榮旅遊");
});

test("provider: empty provider is not written to frontmatter", async () => {
  const { vault, pipeline } = setup({ aiDraft: { ...draft, provider: "" } });
  const out = await pipeline.processIncomingContent("記一下 docker healthcheck", "telegram");
  assert.equal("provider" in vault.readNote(out.result.relativePath).frontmatter, false);
});

test("wrong page: nothing is saved, AI is not called, and the user is told to paste the text", async () => {
  const url = "https://ai-chain.tw/blog/codeburn";
  const { vault, calls, pipeline } = setup({
    fetched: { [url]: { url, ok: false, errorKind: "wrong_page", error: "被導向網站首頁" } },
  });

  await assert.rejects(pipeline.processIncomingContent(url, "telegram"), /抓錯頁面.*貼/);
  assert.equal(calls.askJson.length, 0);
  assert.equal(vault.listNotes().length, 0);
});

test("price and dates from the AI are written to frontmatter verbatim", async () => {
  const { vault, calls, pipeline } = setup({
    aiDraft: { ...draft, price: "NT$37,900 起", dates: "2026-11-08 出發、11/27 出發" },
  });
  const out = await pipeline.processIncomingContent("記一下 北海道團", "telegram");
  const fm = vault.readNote(out.result.relativePath).frontmatter;
  assert.equal(fm.price, "NT$37,900 起");
  assert.equal(fm.dates, "2026-11-08 出發、11/27 出發");
  assert.match(calls.askJson[0].system, /價格、日期.*留空/);
});

test("missing price and dates leave no empty keys in frontmatter", async () => {
  const { vault, pipeline } = setup();
  const out = await pipeline.processIncomingContent("記一下 docker healthcheck", "telegram");
  const fm = vault.readNote(out.result.relativePath).frontmatter;
  assert.equal("price" in fm, false);
  assert.equal("dates" in fm, false);
});

test("my note: the words sent with a URL are kept verbatim above the TL;DR", async () => {
  const url = "https://example.com/post";
  const { vault, pipeline } = setup();
  const out = await pipeline.processIncomingContent(`想帶爸媽去，11 月比較便宜？\n${url}`, "telegram");
  const body = vault.readNote(out.result.relativePath).body;
  assert.match(body, /> \[!note\] 我的備註\n> 想帶爸媽去，11 月比較便宜？/);
  assert.doesNotMatch(body.slice(0, body.indexOf("TL;DR")).split("我的備註")[1] || "", /example\.com/);
  assert.ok(body.indexOf("我的備註") < body.indexOf("TL;DR"));
});

test("my note: a bare URL gets no note block", async () => {
  const { vault, pipeline } = setup();
  const out = await pipeline.processIncomingContent("https://example.com/post", "telegram");
  assert.doesNotMatch(vault.readNote(out.result.relativePath).body, /我的備註/);
});

test("my note: plain text without a URL is unchanged (no note block)", async () => {
  const { vault, pipeline } = setup();
  const out = await pipeline.processIncomingContent("記一下 docker healthcheck", "telegram");
  assert.doesNotMatch(vault.readNote(out.result.relativePath).body, /我的備註/);
});

test("my note: /rebuild keeps the note block written when the note was first saved", async () => {
  const url = "https://example.com/a";
  const { vault, pipeline } = setup({ fetched: { [url]: { url, ok: true, title: "A", text: "原文" } } });
  const old = vault.writeNote({
    folder: "技術/前端框架/Vue", title: "舊筆記", tags: ["Vue"], summary: "s", sources: [url], type: "article", sourceChannel: "t",
    body: "> [!note] 我的備註\n> 想帶爸媽去\n\n> [!summary] TL;DR\n> 舊內容",
  }).relativePath;

  await pipeline.refreshNote(old);

  const body = vault.readNote(old).body;
  assert.match(body, /> \[!note\] 我的備註\n> 想帶爸媽去/);
  assert.ok(body.indexOf("我的備註") < body.indexOf("TL;DR"));
});

test("same tour, another departure: listed domain URL one segment deeper is a duplicate and gets recorded", async () => {
  const { vault, calls, pipeline } = setup();
  const notePath = vault.writeNote({
    ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: ["https://www.dtsgroup.com.tw/group/DTS26-SPK059"], sourceChannel: "telegram",
  }).relativePath;
  const deeper = "https://www.dtsgroup.com.tw/group/DTS26-SPK059/DTS26B08HBR1";

  const out = await pipeline.processIncomingContent(deeper, "telegram");
  await pipeline.processIncomingContent(deeper, "telegram"); // 再丟一次不會重複記

  assert.equal(out.duplicate, true);
  assert.equal(out.duplicatePath, notePath);
  assert.deepEqual(out.recordedUrls, [deeper]);
  assert.deepEqual(vault.readNote(notePath).sources, ["https://www.dtsgroup.com.tw/group/DTS26-SPK059", deeper]);
  assert.equal(vault.listNotes().length, 1);
  assert.equal(calls.askJson.length, 0);
});

test("same tour: the shorter URL arriving after the deeper one is also a duplicate", async () => {
  const { vault, pipeline } = setup();
  const notePath = vault.writeNote({
    ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: ["https://www.dtsgroup.com.tw/group/A/B1"], sourceChannel: "telegram",
  }).relativePath;
  const out = await pipeline.processIncomingContent("https://www.dtsgroup.com.tw/group/A", "telegram");
  assert.equal(out.duplicatePath, notePath);
  assert.deepEqual(vault.readNote(notePath).sources, ["https://www.dtsgroup.com.tw/group/A/B1", "https://www.dtsgroup.com.tw/group/A"]);
});

test("same parent path on an unlisted domain is not a duplicate", async () => {
  const { vault, pipeline } = setup();
  vault.writeNote({ ...draft, folder: "技術/DevOps與部署/Docker", body: "內文", sources: ["https://blog.com/vue"], sourceChannel: "telegram" });
  const out = await pipeline.processIncomingContent("https://blog.com/vue/composables", "telegram");
  assert.notEqual(out.duplicate, true);
});

test("same tour: a new departure is appended when other_sources already exists", async () => {
  const { vault, pipeline } = setup();
  const base = "https://www.dtsgroup.com.tw/group/A";
  const notePath = vault.writeNote({
    ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: [base, `${base}/B1`], sourceChannel: "telegram",
  }).relativePath;
  await pipeline.processIncomingContent(`${base}/B2`, "telegram");
  assert.deepEqual(vault.readNote(notePath).sources, [base, `${base}/B1`, `${base}/B2`]);
});

test("review: recording a new departure is committed", async () => {
  const { vault, calls, pipeline } = setup();
  vault.writeNote({ ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: ["https://www.dtsgroup.com.tw/group/A"], sourceChannel: "telegram" });
  await pipeline.processIncomingContent("https://www.dtsgroup.com.tw/group/A/B1", "telegram");
  assert.equal(calls.git.length, 1);
});

test("review: sibling departures (only the last segment differs) are the same tour", async () => {
  const { vault, pipeline } = setup();
  const notePath = vault.writeNote({ ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: ["https://www.dtsgroup.com.tw/group/A/B1"], sourceChannel: "telegram" }).relativePath;
  const out = await pipeline.processIncomingContent("https://www.dtsgroup.com.tw/group/A/B2", "telegram");
  assert.equal(out.duplicatePath, notePath);
});

test("review: different tours on the listed domain are not duplicates", async () => {
  const { vault, pipeline } = setup();
  vault.writeNote({ ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: ["https://www.dtsgroup.com.tw/group/A"], sourceChannel: "telegram" });
  const out = await pipeline.processIncomingContent("https://www.dtsgroup.com.tw/group/B", "telegram");
  assert.notEqual(out.duplicate, true);
});

test("review: unrelated URLs in the same message are not filed into the duplicate note", async () => {
  const { vault, pipeline } = setup();
  const notePath = vault.writeNote({ ...draft, folder: "旅遊/日本/北海道", body: "內文", sources: ["https://www.dtsgroup.com.tw/group/A"], sourceChannel: "telegram" }).relativePath;
  const out = await pipeline.processIncomingContent("https://www.dtsgroup.com.tw/group/A/B1 https://blog.com/unrelated", "telegram");
  assert.deepEqual(out.recordedUrls, ["https://www.dtsgroup.com.tw/group/A/B1"]);
  assert.ok(!vault.readNote(notePath).sources.includes("https://blog.com/unrelated"));
});

test("review: nothing is claimed as recorded when the note's frontmatter could not be updated", async () => {
  const { vault, pipeline } = setup();
  const notePath = "旅遊/日本/北海道/手寫.md";
  vault.writeFile(notePath, "---\ntitle: 手寫\nsource:\n  - https://www.dtsgroup.com.tw/group/A\n---\n\n內文\n");
  const out = await pipeline.processIncomingContent("https://www.dtsgroup.com.tw/group/A/B1", "telegram");
  assert.equal(out.duplicatePath, notePath);
  assert.deepEqual(out.recordedUrls, []);
});

test("review: punctuation left after removing the URL is not a note", async () => {
  const { vault, pipeline } = setup();
  const out = await pipeline.processIncomingContent("(https://example.com/post)。", "telegram");
  assert.doesNotMatch(vault.readNote(out.result.relativePath).body, /我的備註/);
});

test("review: rebuild without the original does not feed the note block to the AI", async () => {
  const url = "https://example.com/gone";
  const { vault, calls, pipeline } = setup();
  const old = vault.writeNote({
    folder: "技術/前端框架/Vue", title: "舊筆記", tags: ["Vue"], summary: "s", sources: [url], type: "article", sourceChannel: "t",
    body: "> [!note] 我的備註\n> 想帶爸媽去\n\n> [!summary] TL;DR\n> 舊內容",
  }).relativePath;
  await pipeline.refreshNote(old);
  assert.doesNotMatch(calls.askJson[0].user, /想帶爸媽去/);
  assert.match(calls.askJson[0].user, /舊內容/);
});
