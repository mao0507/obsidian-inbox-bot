import { test } from "node:test";
import assert from "node:assert/strict";
import { createCliBackend, createApiBackend } from "../src/aiBackends.js";
import { createNoteDrafter } from "../src/noteDrafter.js";

const good = {
  category: "技術",
  subcategory: "前端框架",
  primary_tag: "Vue",
  title: "t",
  tags: ["a"],
  summary: "s",
  kind: "觀念",
  tldr: "一句話重點",
  key_points: ["重點一", "重點二"],
  content: "## 第一章\n完整細節與步驟",
  actions: ["試著做 X"],
  review_questions: [{ question: "為什麼要 X？", answer: "因為 Y" }],
  quotes: ["原文的關鍵句子"],
};
const prompts = () => ({ system: "SYS", user: "USER" });

// draftNote 回傳 AI 的欄位 + 程式依模板排好的 body
function assertDraft(draft) {
  for (const [key, value] of Object.entries(good)) assert.deepEqual(draft[key], value, key);
  assert.ok(draft.body.includes(good.content));
}

function cliReturning(stdout) {
  const calls = [];
  const run = async (command, args, input) => {
    calls.push({ command, args, input });
    return stdout;
  };
  return { backend: createCliBackend({ command: "claude", args: ["-p"], run }), calls };
}

function apiReturning(input) {
  const client = { messages: { create: async () => ({ content: [{ type: "tool_use", name: "file_note", input }] }) } };
  return createApiBackend({ apiKey: "k", model: "m", client });
}

const draftWith = (backend) => createNoteDrafter({ backend, buildPrompts: prompts }).draftNote({ rawText: "x" });

for (const [label, stdout] of [
  ["claude json envelope", JSON.stringify({ type: "result", result: JSON.stringify(good) })],
  ["bare json", JSON.stringify(good)],
  ["json wrapped in prose", `好的：\n${JSON.stringify(good)}\n以上`],
]) {
  test(`CLI backend parses ${label}`, async () => {
    const { backend, calls } = cliReturning(stdout);
    assertDraft(await draftWith(backend));
    assert.match(calls[0].input, /SYS[\s\S]*USER[\s\S]*"category": "技術" \| "AI"/);
    assert.match(calls[0].input, /"review_questions": \{ "question": string, "answer": string \}\[\]/);
  });
}

test("API backend returns the same draft", async () => {
  assertDraft(await draftWith(apiReturning(good)));
});

test("CLI backend throws on non-JSON output", async () => {
  await assert.rejects(draftWith(cliReturning("I cannot do that").backend), /沒有回傳可用/);
});

test("missing required field is rejected, for both adapters", async () => {
  const { tldr, ...noTldr } = good;
  for (const backend of [cliReturning(JSON.stringify(noTldr)).backend, apiReturning(noTldr)]) {
    await assert.rejects(draftWith(backend), /缺少欄位「tldr」/);
  }
});

test("body follows the 精讀 template order", async () => {
  const { body } = await draftWith(apiReturning(good));
  const order = [
    "TL;DR",
    "一句話重點",
    "## 重點",
    "- 重點一",
    "## 詳細內容",
    "完整細節與步驟",
    "## 延伸與行動",
    "- 試著做 X",
    "## 回顧問題",
    "為什麼要 X？",
    "因為 Y",
    "## 原文摘錄",
    "> 原文的關鍵句子",
  ];
  let last = -1;
  for (const marker of order) {
    const at = body.indexOf(marker);
    assert.ok(at > last, `「${marker}」應出現在前一段之後`);
    last = at;
  }
});

test("optional sections are omitted when empty", async () => {
  const { body } = await draftWith(apiReturning({ ...good, actions: [], quotes: undefined }));
  assert.doesNotMatch(body, /## 延伸與行動|## 原文摘錄/);
});

test("unknown kind is dropped instead of written", async () => {
  assert.equal((await draftWith(apiReturning({ ...good, kind: "亂寫" }))).kind, "");
});

test("CLI ask unwraps envelope or returns raw text", async () => {
  assert.equal(await cliReturning(JSON.stringify({ result: " answer " })).backend.ask("q", { instruction: "i" }), "answer");
  assert.equal(await cliReturning("plain\n").backend.ask("q", { instruction: "i" }), "plain");
});
