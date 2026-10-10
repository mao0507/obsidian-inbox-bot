import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createPipeline } from "../src/pipeline.js";

const draft = {
  folder: "知識庫",
  filename: "Docker 健康檢查",
  title: "Docker 健康檢查",
  tags: ["Docker"],
  summary: "healthcheck 寫法",
  body: "內文",
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
  vault.writeNote({ ...draft, sources: ["https://example.com/post"], sourceChannel: "telegram" });

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
