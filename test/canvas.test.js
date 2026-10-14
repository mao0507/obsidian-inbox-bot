import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNoteStore } from "../src/noteStore.js";
import { createCanvas } from "../src/canvasWriter.js";
import { mindMapLayout, flowLayout, columnsLayout, clusterLayout } from "../src/canvasLayout.js";
import { buildCatalog, selectRelevantNotes } from "../src/vaultCatalog.js";
import { createCanvasMaker, MAX_CANVAS_NODES, CANVAS_KINDS, researchOutline, existingRelations } from "../src/canvasMaker.js";
import { notePathOfReply } from "../src/botCanvas.js";

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

// ---- 規劃圖 ----

const inside = (inner, outer) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

test("flow layout: phases top-to-bottom, steps left-to-right inside their group, nothing overlaps", () => {
  const step = (leaves) => ({ size: { width: 320, height: 160 }, leaves: Array.from({ length: leaves }, () => ({ width: 320, height: 220 })) });
  const out = flowLayout({ header: { width: 600, height: 160 }, phases: [{ steps: [step(1), step(0), step(2)] }, { steps: [step(0)] }, { steps: [step(3), step(1)] }] });

  out.phases.forEach((phase, p) => {
    phase.steps.forEach((s, i) => {
      assert.ok(inside(s.box, phase.group), `step ${p}.${i} inside group`);
      s.leaves.forEach((leaf) => assert.ok(inside(leaf, phase.group), "leaf inside group"));
      if (i) assert.ok(s.box.x > phase.steps[i - 1].box.x, "steps go left to right");
    });
    if (p) assert.ok(phase.group.y >= out.phases[p - 1].group.y + out.phases[p - 1].group.height, "phases go top to bottom");
  });
  const boxes = [out.header, ...out.phases.flatMap((ph) => ph.steps.flatMap((s) => [s.box, ...s.leaves]))];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${i} vs ${j}`);
});

test("plan canvas: groups per phase, steps chained in order across phases, notes hang off their steps", async () => {
  const vault = tempVault();
  const a = note(vault, "旅遊/日本/北海道", "北海道懶人包", ["北海道"]);
  const map = {
    title: "北海道 5 天行程",
    summary: "札幌進出，第 3 天往小樽",
    phases: [
      { title: "Day 1-2 札幌", steps: [{ title: "抵達新千歲", detail: "JR 到札幌", notes: [a] }, { title: "大通公園", detail: "", notes: [] }] },
      { title: "Day 3 小樽", steps: [{ title: "小樽運河", detail: "", notes: ["不存在.md"] }] },
    ],
  };
  const out = await createCanvasMaker({ vault, ai: fakeAi({ picks: [a], map, tool: "plan_map" }) }).plan("北海道 5 天");

  assert.equal(out.path, "Canvas/規劃/北海道 5 天行程.canvas");
  const json = JSON.parse(vault.readFile(out.path));
  const groups = json.nodes.filter((n) => n.type === "group").map((g) => g.label);
  assert.deepEqual(groups, ["Day 1-2 札幌", "Day 3 小樽"]);
  const textId = (prefix) => json.nodes.find((n) => n.type === "text" && n.text.startsWith(prefix)).id;
  const chain = [textId("**抵達新千歲**"), textId("**大通公園**"), textId("**小樽運河**")];
  for (let i = 1; i < chain.length; i++) assert.ok(json.edges.some((e) => e.fromNode === chain[i - 1] && e.toNode === chain[i]), `step ${i} chained`);
  const file = json.nodes.find((n) => n.type === "file");
  assert.equal(file.file, a);
  assert.ok(json.edges.some((e) => e.fromNode === chain[0] && e.toNode === file.id));
  assert.deepEqual(out.usedNotes, [a]);
});

test("plan canvas works with no related notes", async () => {
  const vault = tempVault();
  const map = { title: "學 Rust", summary: "s", phases: [{ title: "基礎", steps: [{ title: "所有權", detail: "", notes: [] }] }] };
  const out = await createCanvasMaker({ vault, ai: fakeAi({ picks: [], map, tool: "plan_map" }) }).plan("學 Rust");
  assert.deepEqual(out.usedNotes, []);
  assert.ok(JSON.parse(vault.readFile(out.path)).nodes.length >= 3);
});

// ---- 研究總覽 ----

const researchBody = `> [!summary] TL;DR
> 重點

## 詳細內容

### 0. 研究問題與角度
說明

### 1. 來源與設計理念
內容 https://github.com/x/skills/issues/1

### 2. 需求訪談機制
內容 [影片](https://www.youtube.com/watch?v=abc)

### 參考來源清單
- https://example.com/a

## 概念卡

- [[卡片/Phase Gate|Phase Gate]]

> [!note]- 原始研究報告（NotebookLM）
> 見 https://example.com/b 與 https://github.com/x/skills/issues/1`;

function researchNote(vault, title) {
  vault.writeFile("卡片/Phase Gate.md", "---\ntitle: Phase Gate\ntype: card\n---\n\n# Phase Gate\n\n說明\n");
  return vault.writeNote({
    folder: "AI/編程助手/ClaudeCode",
    title,
    tags: ["ClaudeCode"],
    cards: ["Phase Gate"],
    summary: "s",
    body: researchBody,
    type: "research",
    topic: `${title} 是什麼`,
    notebook_id: "nb1",
    sourceChannel: "telegram-notebook",
  }).relativePath;
}

test("research outline: question, angles from detail sections (minus reference lists), cards and unique URLs", () => {
  const vault = tempVault();
  const p = researchNote(vault, "grill-me 研究");
  const outline = researchOutline(vault.readNote(p));
  assert.equal(outline.question, "grill-me 研究 是什麼");
  assert.deepEqual(outline.angles, ["來源與設計理念", "需求訪談機制"]);
  assert.deepEqual(outline.cards, ["卡片/Phase Gate.md"]);
  assert.deepEqual(outline.urls, ["https://github.com/x/skills/issues/1", "https://www.youtube.com/watch?v=abc", "https://example.com/a", "https://example.com/b"]);
});

test("columns layout: three columns per row, rows stacked, nothing overlaps", () => {
  const col = (n) => Array.from({ length: n }, () => ({ width: 360, height: 120 }));
  const out = columnsLayout({ rows: [{ columns: [col(2), col(5), col(3)] }, { columns: [col(1), col(2), col(0)] }] });
  const boxes = out.rows.flatMap((r) => r.columns.flat());
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]));
  out.rows.forEach((r) => r.columns.flat().forEach((b) => assert.ok(inside(b, r.group))));
  assert.ok(out.rows[1].group.y >= out.rows[0].group.y + out.rows[0].group.height);
  assert.ok(out.rows[0].columns[1][0].x > out.rows[0].columns[0][0].x && out.rows[0].columns[2][0].x > out.rows[0].columns[1][0].x);
});

test("research canvas: question → angles, research note and sources in columns; only research notes are offered", async () => {
  const vault = tempVault();
  const p = researchNote(vault, "grill-me 研究");
  note(vault, "技術/前端框架/Vue", "不是研究", ["Vue"]);
  let offered = "";
  const ai = { askJson: async (input) => ((offered = input.user), { paths: [p] }) };

  const out = await createCanvasMaker({ vault, ai }).research("grill-me");

  assert.doesNotMatch(offered, /不是研究/, "only research notes are in the catalog");
  assert.equal(out.path, "Canvas/研究/grill-me 研究 研究總覽.canvas");
  const json = JSON.parse(vault.readFile(out.path));
  const question = json.nodes.find((n) => n.type === "text" && n.text.includes("grill-me 研究 是什麼"));
  const angles = json.nodes.filter((n) => n.type === "text" && /來源與設計理念|需求訪談機制/.test(n.text));
  assert.equal(angles.length, 2);
  angles.forEach((a) => assert.ok(json.edges.some((e) => e.fromNode === question.id && e.toNode === a.id)));
  assert.ok(json.nodes.some((n) => n.type === "file" && n.file === p));
  assert.ok(json.nodes.some((n) => n.type === "file" && n.file === "卡片/Phase Gate.md"));
  assert.ok(json.nodes.some((n) => n.type === "link" && n.url === "https://example.com/a"));
  assert.deepEqual(out.usedNotes, [p]);
});

test("research canvas without related research explains what to do instead", async () => {
  const vault = tempVault();
  note(vault, "技術/前端框架/Vue", "不是研究", ["Vue"]);
  const ai = { askJson: async () => ({ paths: [] }) };
  await assert.rejects(createCanvasMaker({ vault, ai }).research("grill-me"), /\/notebook[\s\S]*\/canvas 說明/);
});

// ---- 關聯圖 ----

test("cluster layout: centre on top, clusters as non-overlapping groups containing their items", () => {
  const items = (n) => Array.from({ length: n }, () => ({ width: 360, height: 220 }));
  const out = clusterLayout({ center: { width: 500, height: 160 }, clusters: [items(3), items(1), items(5), items(2)] });
  const boxes = [out.center, ...out.clusters.flatMap((c) => c.items)];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]));
  out.clusters.forEach((c) => c.items.forEach((b) => assert.ok(inside(b, c.group))));
  for (let i = 0; i < out.clusters.length; i++)
    for (let j = i + 1; j < out.clusters.length; j++) assert.ok(!overlaps(out.clusters[i].group, out.clusters[j].group));
  out.clusters.forEach((c) => assert.ok(c.group.y > out.center.y + out.center.height));
});

function relationVault() {
  const vault = tempVault();
  vault.writeFile("卡片/Proxy.md", "---\ntitle: Proxy\ntype: card\n---\n\n# Proxy\n\n說明\n");
  const a = vault.writeNote({ folder: "技術/前端框架/Vue", title: "Vue 響應式", tags: ["Vue"], cards: ["Proxy"], summary: "s", body: "內文\n\n## 相關筆記\n\n- [[技術/前端框架/Vue/Vue Composables|Vue Composables]]", type: "note", sourceChannel: "t" }).relativePath;
  const b = note(vault, "技術/前端框架/Vue", "Vue Composables", ["Vue"]);
  const c = note(vault, "技術/語言基礎/JavaScript", "JS Proxy 物件", ["JavaScript"]);
  return { vault, a, b, c, card: "卡片/Proxy.md" };
}

test("existing relations: wikilinks between picked notes and note → card", () => {
  const { vault, a, b, c, card } = relationVault();
  const rels = existingRelations([a, b, c, card].map((p) => vault.readNote(p)));
  assert.deepEqual(
    rels.map((r) => `${r.from}->${r.to}`).sort(),
    [`${a}->${b}`, `${a}->${card}`].sort()
  );
});

test("relation canvas: groups by folder, thin existing edges, coloured labelled AI edges between real nodes, fixed filename", async () => {
  const { vault, a, b, c, card } = relationVault();
  const map = {
    title: "Vue 響應式關聯",
    summary: "s",
    relations: [
      { from: a, to: b, label: "延伸" }, // 已有既有連結 -> 升級成帶標籤
      { from: c, to: a, label: "實作基礎" },
      { from: a, to: "不存在.md", label: "x" },
      { from: a, to: a, label: "自己" },
    ],
  };
  const ai = { askJson: async (input) => (input.tool.name === "select_notes" ? { paths: [a, b, c, card] } : map) };

  const out = await createCanvasMaker({ vault, ai }).relate("Vue");

  assert.equal(out.path, "Canvas/關聯/Vue 關聯圖.canvas");
  const json = JSON.parse(vault.readFile(out.path));
  const groups = json.nodes.filter((n) => n.type === "group").map((g) => g.label).sort();
  assert.deepEqual(groups, ["概念卡", "技術/前端框架/Vue", "技術/語言基礎/JavaScript"].sort());
  const id = (file) => json.nodes.find((n) => n.file === file).id;
  const edge = (from, to) => json.edges.filter((e) => e.fromNode === id(from) && e.toNode === id(to));
  assert.equal(edge(a, b).length, 1, "no duplicate edge for the same pair");
  assert.equal(edge(a, b)[0].label, "延伸");
  assert.ok(edge(a, b)[0].color, "AI edges are coloured");
  assert.equal(edge(c, a)[0].label, "實作基礎");
  assert.ok(!edge(a, card)[0].label && !edge(a, card)[0].color, "existing-only edge stays plain");
  assert.equal(json.edges.length, 3);
});

test("relation canvas stays within the node cap when notes are spread over many folders", async () => {
  const vault = tempVault();
  const paths = Array.from({ length: 22 }, (_, i) => note(vault, `技術/前端框架/T${i}`, `筆記${i}`, [`T${i}`]));
  const ai = { askJson: async (input) => (input.tool.name === "select_notes" ? { paths } : { title: "t", summary: "s", relations: [] }) };
  const out = await createCanvasMaker({ vault, ai }).relate("x");
  const json = JSON.parse(vault.readFile(out.path));
  assert.ok(json.nodes.length <= MAX_CANVAS_NODES, `${json.nodes.length} nodes`);
  assert.ok(json.nodes.some((n) => n.type === "text" && n.text.startsWith("## 延伸閱讀")));
});

test("relation canvas skips plain links inside the same group (the group already says they belong together)", async () => {
  const vault = tempVault();
  const b = note(vault, "技術/前端框架/Vue", "B", ["Vue"]);
  const a = vault.writeNote({ folder: "技術/前端框架/Vue", title: "A", tags: ["Vue"], summary: "s", body: "見 [[技術/前端框架/Vue/B|B]]", type: "note", sourceChannel: "t" }).relativePath;
  const ai = { askJson: async (input) => (input.tool.name === "select_notes" ? { paths: [a, b] } : { title: "t", summary: "s", relations: [] }) };
  const out = await createCanvasMaker({ vault, ai }).relate("y");
  assert.equal(JSON.parse(vault.readFile(out.path)).edges.length, 0);
});

// ---- 關聯圖增量更新 ----

async function relationCanvasEditedByUser() {
  const ctx = relationVault();
  let picks = [ctx.a, ctx.b];
  const ai = { askJson: async (input) => (input.tool.name === "select_notes" ? { paths: picks } : { title: "t", summary: "s", relations: [{ from: ctx.a, to: ctx.c, label: "比較" }] }) };
  const maker = createCanvasMaker({ vault: ctx.vault, ai });
  const { path: file } = await maker.relate("Vue");
  // 使用者在 Obsidian 裡：把 a 拖到別處、自己加一張文字卡並連到 a
  const json = JSON.parse(ctx.vault.readFile(file));
  const aNode = json.nodes.find((n) => n.file === ctx.a);
  aNode.x = 5000;
  aNode.y = -3000;
  json.nodes.push({ id: "mynote", type: "text", text: "我的筆記", x: 6000, y: 0, width: 200, height: 100 });
  json.edges.push({ id: "myedge", fromNode: "mynote", toNode: aNode.id });
  ctx.vault.writeFile(file, JSON.stringify(json));
  return { ...ctx, file, maker, setPicks: (p) => (picks = p), read: () => JSON.parse(ctx.vault.readFile(file)) };
}

test("relation canvas update keeps user-moved positions and user-added cards and edges", async () => {
  const t = await relationCanvasEditedByUser();
  const out = await t.maker.relate("Vue");
  const json = t.read();
  assert.equal(out.path, t.file);
  const aNode = json.nodes.find((n) => n.file === t.a);
  assert.deepEqual([aNode.x, aNode.y], [5000, -3000]);
  assert.ok(json.nodes.some((n) => n.id === "mynote"));
  assert.ok(json.edges.some((e) => e.id === "myedge"));
  assert.ok(!json.nodes.some((n) => n.type === "group" && n.label === "新增"), "nothing new -> no 新增 group");
});

test("relation canvas update puts new notes inside the 新增 group and links them", async () => {
  const t = await relationCanvasEditedByUser();
  t.setPicks([t.a, t.b, t.c]);
  await t.maker.relate("Vue");
  const json = t.read();
  const group = json.nodes.find((n) => n.type === "group" && n.label === "新增");
  const cNode = json.nodes.find((n) => n.file === t.c);
  assert.ok(group && cNode);
  assert.ok(cNode.x >= group.x && cNode.x + cNode.width <= group.x + group.width && cNode.y >= group.y && cNode.y + cNode.height <= group.y + group.height);
  for (const n of json.nodes.filter((n) => n !== group && n !== cNode)) assert.ok(!overlaps(group, n), "新增 group sits beside the old map");
  const aId = json.nodes.find((n) => n.file === t.a).id;
  assert.ok(json.edges.some((e) => e.label === "比較" && [e.fromNode, e.toNode].sort().join() === [aId, cNode.id].sort().join()));
});

test("relation canvas update removes nodes and edges of deleted notes", async () => {
  const t = await relationCanvasEditedByUser();
  const bId = t.read().nodes.find((n) => n.file === t.b).id;
  t.vault.deleteFile(t.b);
  t.setPicks([t.a]);
  await t.maker.relate("Vue");
  const json = t.read();
  assert.ok(!json.nodes.some((n) => n.file === t.b));
  assert.ok(!json.edges.some((e) => e.fromNode === bId || e.toNode === bId));
});

test("relation canvas update follows notes moved to another folder", async () => {
  const t = await relationCanvasEditedByUser();
  const bId = t.read().nodes.find((n) => n.file === t.b).id;
  const newPath = t.vault.moveNote(t.b, "技術/前端框架/Vue3");
  t.setPicks([t.a, newPath]);
  await t.maker.relate("Vue");
  const json = t.read();
  assert.equal(json.nodes.find((n) => n.id === bId).file, newPath);
  assert.equal(json.nodes.filter((n) => n.file === newPath).length, 1, "moved note is not added again");
});

// ---- 自動判斷類型、回覆筆記 ----

test("pickKind only returns one of the four kinds and falls back to explain", async () => {
  const vault = tempVault();
  const maker = (answer) => createCanvasMaker({ vault, ai: { askJson: answer } });
  for (const kind of CANVAS_KINDS) assert.equal(await maker(async () => ({ kind })).pickKind("q"), kind);
  assert.equal(await maker(async () => ({ kind: "pie_chart" })).pickKind("q"), "explain");
  assert.equal(await maker(async () => ({})).pickKind("q"), "explain");
  assert.equal(await maker(async () => { throw new Error("boom"); }).pickKind("q"), "explain");
});

test("notePathOfReply reads the saved note path from a bot reply", () => {
  assert.equal(notePathOfReply({ text: "✅ 已存進 Obsidian\n標題：A\n檔名：技術/前端框架/Vue/A b.md\n摘要：s" }), "技術/前端框架/Vue/A b.md");
  assert.equal(notePathOfReply({ text: "隨便一則訊息" }), null);
  assert.equal(notePathOfReply(undefined), null);
});
