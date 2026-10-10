import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createPipeline } from "../src/pipeline.js";

const draft = {
  folder: "知識庫",
  title: "Docker 健康檢查",
  tags: ["Docker"],
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
function setup({ aiDraft = draft, fetched = {}, gitResult = { attempted: false }, report } = {}) {
  const vault = createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-test-")));
  const calls = { askJson: [], fetch: [], git: [], research: [] };
  const ai = {
    name: "fake",
    ask: async () => "",
    askJson: async (input) => {
      calls.askJson.push(input);
      return aiDraft;
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
    researchTopic: async (topic) => {
      calls.research.push(topic);
      return report;
    },
  };
  return { vault, calls, pipeline: createPipeline({ vault, ai, fetcher, notebook, git }) };
}

test("plain text: drafts, writes to vault, then commits", async () => {
  const { vault, calls, pipeline } = setup();

  const out = await pipeline.processIncomingContent("記一下 docker healthcheck", "telegram");

  assert.equal(out.result.relativePath, "知識庫/Docker 健康檢查.md");
  assert.equal(vault.readNote(out.result.relativePath).title, "Docker 健康檢查");
  assert.equal(calls.fetch.length, 0);
  assert.deepEqual(calls.git, ["新增筆記：Docker 健康檢查（知識庫）"]);
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
  vault.writeNote({ ...draft, body: "內文", sources: ["https://example.com/post"], sourceChannel: "telegram" });

  const out = await pipeline.processIncomingContent("https://example.com/post?utm_source=x", "telegram");

  assert.equal(out.duplicate, true);
  assert.equal(out.duplicatePath, "知識庫/Docker 健康檢查.md");
  assert.equal(calls.askJson.length, 0);
});

test("invalid folder from AI falls back to inbox", async () => {
  const { pipeline } = setup({ aiDraft: { ...draft, folder: "亂寫" } });
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
  assert.match(calls.askJson[0].user, /研究主題：量子運算（使用者原始輸入：https:\/\/youtu.be\/abc）/);
  assert.match(calls.askJson[0].user, /報告全文 XYZ/);
  assert.equal(out.notebookId, "nb1");
  assert.ok(vault.readNote(out.result.relativePath));
});

test("related links and MOC run after write", async () => {
  const { vault, pipeline } = setup({ aiDraft: { ...draft, folder: "AI/ClaudeCode/教學文章" } });
  await pipeline.processIncomingContent("a", "telegram");
  const out = await pipeline.processIncomingContent("b", "telegram");

  assert.equal(out.relatedResult.linkedCount, 1);
  assert.deepEqual(out.mocResult, { updated: true, mocPath: "AI/AI地圖.md" });
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
