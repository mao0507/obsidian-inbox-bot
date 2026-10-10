import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";

function tempVault() {
  return createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-")));
}

const draft = {
  folder: "旅遊/日本/北海道",
  filename: "小樽: 運河",
  title: 'Otaru "運河" #1',
  tags: ["Claude Code", "#旅遊"],
  summary: "一句話: 摘要",
  body: "內文",
  reasoning: "地區明確",
  sources: ["https://a.com/x", "https://b.com/y?q=1"],
  sourceChannel: "telegram",
};

test("write -> read round-trip keeps fields; other_sources never leak into tags", () => {
  const vault = tempVault();
  const { relativePath } = vault.writeNote(draft);

  assert.equal(relativePath, "旅遊/日本/北海道/小樽- 運河.md");
  const note = vault.readNote(relativePath);
  assert.equal(note.title, draft.title);
  assert.equal(note.summary, draft.summary);
  assert.deepEqual(note.tags, ["ClaudeCode", "旅遊"]);
  assert.deepEqual(note.sources, draft.sources);
  assert.match(note.body, /內文/);
});

test("writeNote never overwrites: second write gets (2) suffix", () => {
  const vault = tempVault();
  vault.writeNote(draft);
  assert.equal(vault.writeNote(draft).relativePath, "旅遊/日本/北海道/小樽- 運河 (2).md");
});

test("listNotes skips dot folders and scopes to folder", () => {
  const vault = tempVault();
  vault.writeNote(draft);
  vault.writeNote({ ...draft, folder: "知識庫" });
  vault.writeFile(".obsidian/x.md", "ignored");
  vault.writeFile(".trash/y.md", "ignored");

  assert.equal(vault.listNotes().length, 2);
  assert.deepEqual(vault.listNotes("知識庫").map((n) => n.path), ["知識庫/小樽- 運河.md"]);
});

test("parses CRLF frontmatter written by other editors", () => {
  const vault = tempVault();
  vault.writeFile("a.md", "---\r\ntitle: Hi\r\ntags:\r\n  - x\r\n---\r\nbody\r\n");
  const note = vault.readNote("a.md");
  assert.equal(note.title, "Hi");
  assert.deepEqual(note.tags, ["x"]);
  assert.equal(note.body, "body");
});

test("updateNote writes only when content changes", () => {
  const vault = tempVault();
  const { relativePath } = vault.writeNote(draft);
  assert.equal(vault.updateNote(relativePath, (c) => c), false);
  assert.equal(vault.updateNote(relativePath, (c) => `${c}\nmore`), true);
  assert.match(vault.readNote(relativePath).body, /more$/);
});
