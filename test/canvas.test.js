import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createCanvas } from "../src/canvasWriter.js";
import { mindMapLayout } from "../src/canvasLayout.js";
import { buildCatalog, selectRelevantNotes } from "../src/vaultCatalog.js";
import { createCanvasMaker, MAX_CANVAS_NODES } from "../src/canvasMaker.js";

const tempVault = () => createNoteStore(fs.mkdtempSync(path.join(os.tmpdir(), "canvas-test-")));
const note = (vault, folder, title, tags = []) =>
  vault.writeNote({ folder, title, tags, summary: `${title} 摘要`, body: `${title} 內文`, type: "note", sourceChannel: "t" }).relativePath;

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// ---- canvas 檔案格式 ----

test("canvas JSON: unique node ids, edges point at existing nodes, Obsidian node shapes", () => {
  const canvas = createCanvas();
  const a = canvas.addText({ text: "中心", x: 0, y: 0, width: 300, height: 100 });
  const b = canvas.addFile({ file: "技術/前端框架/Vue/a.md", x: 500, y: 0, width: 300, height: 200 });
  canvas.addGroup({ label: "群組", x: -50, y: -50, width: 900, height: 400 });
  canvas.addEdge({ from: a, to: b, label: "延伸" });

  const json = canvas.toJSON();
  const ids = json.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(json.nodes.map((n) => n.type), ["text", "file", "group"]);
  assert.equal(json.nodes[1].file, "技術/前端框架/Vue/a.md");
  assert.deepEqual([json.edges[0].fromNode, json.edges[0].toNode], [a, b]);
  assert.equal(json.edges[0].label, "延伸");
  assert.throws(() => canvas.addEdge({ from: a, to: "nope" }), /不存在/);
});

// ---- 排版 ----

test("mind map layout: centre, branches and leaves never overlap", () => {
  for (const [branchCount, leavesPer] of [[3, 2], [6, 4], [5, 0]]) {
    const branches = Array.from({ length: branchCount }, (_, i) => ({
      size: { width: 360, height: 200 },
      leaves: Array.from({ length: leavesPer }, () => ({ width: 360, height: 240 })),
    }));
    const boxes = mindMapLayout({ center: { width: 420, height: 220 }, branches });
    const all = [boxes.center, ...boxes.branches.flatMap((b) => [b.box, ...b.leaves])];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(all[i], all[j]), `overlap ${branchCount}/${leavesPer}: ${i} vs ${j}`);
    }
  }
});

// ---- 目錄與挑選 ----

test("catalog lists notes and cards (no maps, no system files); selection keeps only real paths", async () => {
  const vault = tempVault();
  const a = note(vault, "技術/前端框架/Vue", "Vue 響應式", ["Vue"]);
  vault.writeFile("卡片/Proxy.md", "---\ntitle: Proxy\ntype: card\n---\n\n# Proxy\n\n說明\n");
  vault.writeFile("技術/技術地圖.md", "---\ntitle: 技術地圖\ntype: MOC\n---\n");

  const catalog = buildCatalog(vault);
  assert.deepEqual(catalog.map((c) => c.path).sort(), [a, "卡片/Proxy.md"].sort());

  const ai = {
    askJson: async (input) => {
      assert.match(input.user, /Vue 響應式/);
      return { paths: [a, "亂寫/不存在.md", a] };
    },
  };
  assert.deepEqual(await selectRelevantNotes(ai, catalog, "Vue"), [a]);
});

// ---- 說明圖 ----

function fakeAi({ picks, map }) {
  return {
    askJson: async (input) => (input.tool.name === "select_notes" ? { paths: picks } : map),
  };
}

test("explain canvas: centre + branch text cards + note file cards, saved under Canvas/說明 without overwriting", async () => {
  const vault = tempVault();
  const a = note(vault, "技術/前端框架/Vue", "Vue 響應式", ["Vue"]);
  const b = note(vault, "技術/前端框架/Vue", "Vue Composables", ["Vue"]);
  const map = {
    title: "Vue 響應式怎麼運作",
    summary: "Proxy 追蹤讀寫，變動時觸發更新",
    branches: [
      { title: "核心機制", points: ["Proxy 攔截 get/set"], notes: [a] },
      { title: "實務應用", points: ["用 composable 封裝"], notes: [b, "不存在.md"] },
    ],
  };
  const maker = createCanvasMaker({ vault, ai: fakeAi({ picks: [a, b], map }) });

  const out = await maker.explain("Vue 響應式");

  assert.equal(out.path, "Canvas/說明/Vue 響應式怎麼運作.canvas");
  const json = JSON.parse(vault.readFile(out.path));
  const files = json.nodes.filter((n) => n.type === "file").map((n) => n.file);
  assert.deepEqual(files.sort(), [a, b].sort(), "only existing notes become file cards");
  assert.ok(json.nodes.some((n) => n.type === "text" && n.text.includes("Proxy 攔截 get/set")));
  assert.equal(json.edges.length, 4, "centre→2 branches + 2 branch→note");
  assert.deepEqual(out.usedNotes.sort(), [a, b].sort());
  assert.equal(out.summary, map.summary);

  const again = await maker.explain("Vue 響應式");
  assert.equal(again.path, "Canvas/說明/Vue 響應式怎麼運作 (2).canvas");
});

test("explain canvas caps nodes and lists the rest under 延伸閱讀", async () => {
  const vault = tempVault();
  const notes = Array.from({ length: 40 }, (_, i) => note(vault, "技術/前端框架/Vue", `筆記 ${i}`, ["Vue"]));
  const map = {
    title: "很多筆記",
    summary: "s",
    branches: Array.from({ length: 5 }, (_, i) => ({ title: `分支 ${i}`, points: ["p"], notes: notes.slice(i * 8, i * 8 + 8) })),
  };
  const out = await createCanvasMaker({ vault, ai: fakeAi({ picks: notes.slice(0, 25), map }) }).explain("x");
  const json = JSON.parse(vault.readFile(out.path));
  assert.ok(json.nodes.length <= MAX_CANVAS_NODES, `${json.nodes.length} nodes`);
  const further = json.nodes.find((n) => n.type === "text" && n.text.startsWith("## 延伸閱讀"));
  assert.ok(further, "overflow notes go into 延伸閱讀");
  assert.match(further.text, /\[\[技術\/前端框架\/Vue\/筆記 \d+\|筆記 \d+\]\]/);
});
