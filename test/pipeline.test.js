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
  const out = await pipeline.processIncomingContent("隨便", "telegram");
  assert.equal(out.draft.folder, "收件匣/待整理");
});

test("git failure does not fail the note", async () => {
  const { vault, pipeline } = setup({ gitResult: { attempted: true, pushed: false, error: "boom" } });
  const out = await pipeline.processIncomingContent("記一下", "telegram");
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
  await pipeline.processIncomingContent("a", "telegram");
  const out = await pipeline.processIncomingContent("b", "telegram");

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

  assert.equal(type(await pipeline.processIncomingContent("想法", "telegram")), "note");
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
  const note = vault.readNote((await pipeline.processIncomingContent("記一下", "telegram")).result.relativePath);
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
  await pipeline.processIncomingContent("a", "telegram");

  const variant = { ...draft, category: "AI", subcategory: "編程助手", primary_tag: "Claude Code", tags: ["mcp", "claude-code"] };
  const { pipeline: second } = setupWith(vault, { aiDraft: variant });
  const out = await second.processIncomingContent("b", "telegram");

  assert.equal(out.draft.folder, "AI/編程助手/ClaudeCode");
  assert.deepEqual(vault.readNote(out.result.relativePath).tags, ["ClaudeCode", "MCP"]);
  assert.deepEqual(out.createdTags, []);
});

test("brand-new tags are created and reported", async () => {
  const { pipeline } = setup({ aiDraft: { ...draft, primary_tag: "Podman", tags: ["Rootless"] } });
  const out = await pipeline.processIncomingContent("a", "telegram");
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
