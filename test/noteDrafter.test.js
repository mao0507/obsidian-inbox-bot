import { test } from "node:test";
import assert from "node:assert/strict";
import { createCliBackend, createApiBackend } from "../src/aiBackends.js";
import { createNoteDrafter } from "../src/noteDrafter.js";

const good = { folder: "知識庫", filename: "f", title: "t", tags: ["a"], summary: "s", body: "b" };
const prompts = () => ({ system: "SYS", user: "USER" });

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

for (const [label, stdout] of [
  ["claude json envelope", JSON.stringify({ type: "result", result: JSON.stringify(good) })],
  ["bare json", JSON.stringify(good)],
  ["json wrapped in prose", `好的：\n${JSON.stringify(good)}\n以上`],
]) {
  test(`CLI backend parses ${label}`, async () => {
    const { backend, calls } = cliReturning(stdout);
    const draft = await createNoteDrafter({ backend, buildPrompts: prompts }).draftNote({ rawText: "x" });
    assert.deepEqual(draft, good);
    assert.match(calls[0].input, /SYS[\s\S]*USER[\s\S]*"folder": string/);
  });
}

test("CLI backend throws on non-JSON output", async () => {
  const { backend } = cliReturning("I cannot do that");
  await assert.rejects(createNoteDrafter({ backend, buildPrompts: prompts }).draftNote({ rawText: "x" }), /沒有回傳可用/);
});

test("invalid folder falls back to inbox, for both adapters", async () => {
  for (const backend of [cliReturning(JSON.stringify({ ...good, folder: "亂寫" })).backend, apiReturning({ ...good, folder: "亂寫" })]) {
    const draft = await createNoteDrafter({ backend, buildPrompts: prompts }).draftNote({ rawText: "x" });
    assert.equal(draft.folder, "收件匣/待整理");
  }
});

test("missing required field is rejected, for both adapters", async () => {
  const { body, ...noBody } = good;
  for (const backend of [cliReturning(JSON.stringify(noBody)).backend, apiReturning(noBody)]) {
    await assert.rejects(createNoteDrafter({ backend, buildPrompts: prompts }).draftNote({ rawText: "x" }), /缺少欄位「body」/);
  }
});

test("CLI ask unwraps envelope or returns raw text", async () => {
  assert.equal(await cliReturning(JSON.stringify({ result: " answer " })).backend.ask("q", { instruction: "i" }), "answer");
  assert.equal(await cliReturning("plain\n").backend.ask("q", { instruction: "i" }), "plain");
});
