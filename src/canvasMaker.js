import { createCanvas, textCardSize } from "./canvasWriter.js";
import { mindMapLayout, flowLayout, columnsLayout, clusterLayout } from "./canvasLayout.js";
import { buildCatalog, selectRelevantNotes } from "./vaultCatalog.js";
import { titleToFilename, wikiLink, basenameOf } from "./noteStore.js";
import { mergeRelationCanvas } from "./canvasMerge.js";

// /canvas：從 vault 找出跟主題相關的筆記，請 AI 整理成結構，再排版寫成 Obsidian Canvas。
// 文字卡負責「說明」（AI 寫的重點），筆記卡負責「出處」（指向既有筆記，可在 Obsidian 直接預覽、點進去）。
// 一張圖最多 MAX_CANVAS_NODES 個節點，放不下的筆記列在「延伸閱讀」文字卡，避免手機上看不清楚。

export const MAX_CANVAS_NODES = 30;
const CANVAS_ROOT = "Canvas";
const NOTE_BODY_CHARS = 3000;
const FILE_CARD = { width: 400, height: 260 };
const MAX_BRANCHES = 6;
const MAX_PHASES = 6;
const MAX_STEPS = 16; // 規劃圖所有階段加起來的步驟上限

// /canvas 沒指定類型時，讓 AI 判斷畫哪一種（值是 createCanvasMaker 回傳的方法名稱）
export const CANVAS_KINDS = ["explain", "plan", "relate", "research"];
const DEFAULT_KIND = "explain";
const KIND_TOOL = {
  name: "pick_canvas_kind",
  description: "判斷使用者的問題最適合畫成哪一種圖",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: CANVAS_KINDS,
        description:
          "explain：解釋一個概念怎麼運作、是什麼；plan：要安排、規劃、排行程、達成目標的步驟；" +
          "relate：想看某個主題相關的筆記有哪些、彼此怎麼關聯；research：想看已做過的研究整理",
      },
    },
    required: ["kind"],
  },
};

const stringList = (description) => ({ type: "array", items: { type: "string" }, description });
const notesField = stringList("支持這個項目的筆記路徑（原樣照抄提供的路徑）；沒有就給空陣列");

const EXPLAIN_TOOL = {
  name: "explain_map",
  description: "把主題整理成一張說明用的心智圖",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "圖的標題（繁體中文，20 字以內），也是檔名" },
      summary: { type: "string", description: "2~3 句話說清楚這個主題的核心，放在圖的中心" },
      branches: {
        type: "array",
        description: `3~${MAX_BRANCHES} 個分支（面向），例如核心機制、為什麼重要、怎麼用、常見誤區、例子`,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "分支標題（10 字以內）" },
            points: stringList("2~4 個重點，每個一句完整的話"),
            notes: notesField,
          },
          required: ["title", "points", "notes"],
        },
      },
    },
    required: ["title", "summary", "branches"],
  },
};

const PLAN_TOOL = {
  name: "plan_map",
  description: "把目標整理成一張分階段的規劃圖",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "圖的標題（繁體中文，20 字以內），也是檔名" },
      summary: { type: "string", description: "1~2 句話說明這份規劃的整體思路" },
      phases: {
        type: "array",
        description: `2~${MAX_PHASES} 個依序進行的階段（例如 Day 1、第一週、準備期）`,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "階段名稱（15 字以內）" },
            steps: {
              type: "array",
              description: "這個階段依序要做的 1~4 個步驟",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "步驟（15 字以內）" },
                  detail: { type: "string", description: "1~2 句具體做法、注意事項或時間；沒有就空字串" },
                  notes: notesField,
                },
                required: ["title", "detail", "notes"],
              },
            },
          },
          required: ["title", "steps"],
        },
      },
    },
    required: ["title", "summary", "phases"],
  },
};

const bullet = (items) => items.map((p) => `- ${p}`).join("\n");

// 研究總覽每篇研究最多畫幾個角度、幾個來源；最多畫 2 篇研究（2 ×（群組 + 問題 + 筆記 + 7 + 4）+ 延伸閱讀 ≤ 30）
const MAX_RESEARCH_SHOWN = 2;
const MAX_ANGLES = 7;
const MAX_SOURCES = 4;
const URL_PATTERN = /https?:\/\/[^\s)\]>"'，。]+/g;

// 關聯圖：AI 判斷的關係用這個顏色（Obsidian 色號 4 = 綠）並加標籤；vault 既有的關係是預設顏色、無標籤
const AI_RELATION_COLOR = "4";
const MAX_RELATION_NOTES = 22;
const CARD_GROUP = "概念卡";

const pairKey = (a, b) => [a, b].sort().join("\u0000");
const folderOf = (relPath) => relPath.slice(0, relPath.lastIndexOf("/"));

/**
 * 一組筆記之間 vault 裡既有的關係（不需要 AI）：筆記內文裡的 [[連結]]（含相關筆記區塊）、筆記 → 它的概念卡。
 * 只回傳兩端都在這組筆記裡的關係；同一對只算一次。
 */
export function existingRelations(notes) {
  const byKey = new Map();
  for (const n of notes) {
    byKey.set(n.path.replace(/\.md$/, ""), n.path);
    byKey.set(n.path.slice(n.path.lastIndexOf("/") + 1).replace(/\.md$/, ""), n.path);
  }
  const seen = new Set();
  const relations = [];
  const add = (from, to) => {
    if (!to || from === to || seen.has(pairKey(from, to))) return;
    seen.add(pairKey(from, to));
    relations.push({ from, to });
  };
  for (const n of notes) {
    for (const m of n.body.matchAll(/\[\[([^\]|#]+)/g)) add(n.path, byKey.get(m[1].trim().replace(/\.md$/, "")));
    for (const card of n.frontmatter?.cards || []) add(n.path, byKey.get(`卡片/${card}`));
  }
  return relations;
}

const RELATE_TOOL = {
  name: "relation_map",
  description: "整理一組筆記之間的關係",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "這張關聯圖的標題（繁體中文，20 字以內）" },
      summary: { type: "string", description: "1~2 句話說明這些筆記整體的關係脈絡" },
      relations: {
        type: "array",
        description: "筆記之間有意義的關係（最多 15 條），只連真的有關的",
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "筆記路徑（原樣照抄）" },
            to: { type: "string", description: "筆記路徑（原樣照抄）" },
            label: { type: "string", description: "關係（2~6 字，不要加括號說明），例如：依賴、比較、延伸、實作、前置知識、替代方案" },
          },
          required: ["from", "to", "label"],
        },
      },
    },
    required: ["title", "summary", "relations"],
  },
};

/**
 * 從研究筆記擷取研究總覽要的資料（不需要 AI）：
 * - question：frontmatter 的 topic（沒有就用標題）
 * - angles：「## 詳細內容」底下的 ### 章節標題（去掉編號，略過參考來源清單與開頭的研究問題說明）
 * - cards：frontmatter 的概念卡；urls：正文與原始報告裡引用的網址（不重複、依出現順序）
 */
export function researchOutline(note) {
  const details = (note.body.split(/^## 詳細內容\s*$/m)[1] || "").split(/^## /m)[0];
  const angles = [...details.matchAll(/^### (.+)$/gm)]
    .map((m) => m[1].replace(/^\d+[.、]\s*/, "").trim())
    .filter((title) => !/參考|來源清單|reference|研究(問題|背景)|與角度$/i.test(title)); // 報告開頭的「研究問題／背景與角度」說明章節不是角度
  const urls = [...new Set((note.body.match(URL_PATTERN) || []).map((u) => u.replace(/[.,;:]+$/, "")))];
  return {
    question: note.frontmatter?.topic || note.title,
    angles,
    cards: (note.frontmatter?.cards || []).map((name) => `卡片/${name}.md`),
    urls,
  };
}
const bottomOf = (boxes) => Math.max(...boxes.map((b) => b.y + b.height));

/**
 * 節點預算分配：每個項目（分支/步驟）各有一串想掛的筆記，輪流分配，避免一個項目吃光預算；同一篇筆記只出現一次。
 * @returns {{ perItem: string[][], placed: Set<string> }}
 */
function allocateLeaves(noteLists, budget) {
  const placed = new Set();
  const perItem = noteLists.map(() => []);
  let left = budget;
  let progressed = true;
  while (left > 0 && progressed) {
    progressed = false;
    noteLists.forEach((list, i) => {
      const next = list.find((p) => !placed.has(p));
      if (left > 0 && next) {
        perItem[i].push(next);
        placed.add(next);
        left--;
        progressed = true;
      }
    });
  }
  return { perItem, placed };
}

export function createCanvasMaker({ vault, ai }) {
  // 挑出相關筆記並讀內文；focusPath（回覆某篇筆記時）一定放在第一個
  async function gatherNotes(topic, { focusPath } = {}) {
    if (focusPath && vault.readFile(focusPath) === null) throw new Error(`找不到筆記 ${focusPath}（可能已搬家或刪除），改用 /canvas 說明 主題`);
    const picks = await selectRelevantNotes(ai, buildCatalog(vault), topic);
    const paths = focusPath ? [focusPath, ...picks.filter((p) => p !== focusPath)] : picks;
    return paths.map((p) => vault.readNote(p));
  }

  async function askWithNotes({ topic, notes, tool, system }) {
    const notesBlock = notes.map((n) => `【${n.path}】${n.title}\n${n.body.slice(0, NOTE_BODY_CHARS)}`).join("\n\n---\n\n");
    const raw = await ai.askJson({
      system: `${system}只能根據提供的筆記內容，不要編造筆記沒提到的事；notes 欄位只能填提供的筆記路徑。用繁體中文。`,
      user: `主題：${topic}\n\n相關筆記：\n${notesBlock || "（vault 裡沒有相關筆記，依一般知識整理，notes 留空）"}`,
      tool,
    });
    const known = new Set(notes.map((n) => n.path));
    return { raw, onlyKnown: (paths) => [...new Set((paths || []).filter((p) => known.has(p)))] };
  }

  // 放不下的筆記（與挑到但沒被引用的）列在圖最下方的延伸閱讀卡
  function addFurtherReading(canvas, paths, boxes) {
    if (!paths.length) return;
    const text = `## 延伸閱讀\n\n${paths.map((p) => `- ${wikiLink(p)}`).join("\n")}`;
    const size = textCardSize(text, 440);
    canvas.addText({ text, x: -size.width / 2, y: bottomOf(boxes) + 120, ...size });
  }

  function updateRelationCanvas({ path, old, catalog, picks, edges, title }) {
    // 筆記不在原路徑：用檔名找搬家後的位置（tag 合併、重新分類只換資料夾不改檔名）
    const byName = new Map(catalog.map((n) => [basenameOf(n.path), n.path]));
    const resolve = (p) => (vault.readFile(p) !== null ? p : byName.get(basenameOf(p)) ?? null);
    const result = mergeRelationCanvas(old, { resolve, picks, relations: [...edges.values()], cardSize: FILE_CARD, budget: MAX_CANVAS_NODES });
    vault.writeFile(path, `${JSON.stringify(result.canvas, null, 2)}
`);
    const changes = [
      `新增 ${result.added.length} 篇`,
      result.moved && `${result.moved} 篇改指向新路徑`,
      result.removed && `移除 ${result.removed} 篇已刪除的筆記`,
      `補 ${result.edgesAdded} 條關係`,
      result.skipped && `${result.skipped} 篇放不下（圖已達 ${MAX_CANVAS_NODES} 個節點，刪掉一些節點或另開主題）`,
    ].filter(Boolean);
    return {
      path,
      title,
      summary: `已更新既有關聯圖（保留你的排版與自加內容）：${changes.join("、")}`,
      usedNotes: result.canvas.nodes.filter((n) => n.type === "file").map((n) => n.file),
    };
  }

  // 同名不覆蓋：說明/規劃/研究圖是一次性產出，再產生一次就另存新檔
  function save(kind, title, canvas) {
    const base = `${CANVAS_ROOT}/${kind}/${titleToFilename(title)}`;
    let path = `${base}.canvas`;
    for (let n = 2; vault.readFile(path) !== null; n++) path = `${base} (${n}).canvas`;
    vault.writeFile(path, `${JSON.stringify(canvas.toJSON(), null, 2)}\n`);
    return path;
  }

  return {
    /** 判斷問題適合哪一種圖；AI 失敗或回了奇怪的值就退回說明圖 */
    async pickKind(question) {
      try {
        const { kind } = await ai.askJson({
          system: "你在幫使用者決定要把問題畫成哪一種 Obsidian Canvas。只選一種。",
          user: question,
          tool: KIND_TOOL,
        });
        return CANVAS_KINDS.includes(kind) ? kind : DEFAULT_KIND;
      } catch (err) {
        console.error("判斷 canvas 類型失敗，改用說明圖：", err?.message || err);
        return DEFAULT_KIND;
      }
    },

    /**
     * 說明圖：中心是主題摘要，往外是各面向（重點文字卡），每個面向連到支持它的筆記卡。
     * @returns {{ path, title, summary, usedNotes: string[] }}
     */
    async explain(topic, { focusPath } = {}) {
      const notes = await gatherNotes(topic, { focusPath });
      const { raw: map, onlyKnown } = await askWithNotes({
        topic,
        notes,
        tool: EXPLAIN_TOOL,
        system: "你在幫使用者把一個主題整理成說明用的心智圖。",
      });
      const branches = (map.branches || []).slice(0, MAX_BRANCHES).map((b) => ({
        title: String(b.title || "").trim(),
        points: (b.points || []).filter(Boolean),
        notes: onlyKnown(b.notes),
      }));
      // 節點預算：中心 + 分支 + 延伸閱讀卡，剩下的給筆記卡
      const { perItem, placed } = allocateLeaves(
        branches.map((b) => b.notes),
        MAX_CANVAS_NODES - 1 - branches.length - 1
      );

      const centerText = `# ${map.title}\n\n${map.summary}`;
      const branchTexts = branches.map((b) => `## ${b.title}\n\n${bullet(b.points)}`);
      const layout = mindMapLayout({
        center: textCardSize(centerText, 440),
        branches: branches.map((_, i) => ({ size: textCardSize(branchTexts[i], 380), leaves: perItem[i].map(() => FILE_CARD) })),
      });

      const canvas = createCanvas();
      const center = canvas.addText({ text: centerText, color: "6", ...layout.center });
      layout.branches.forEach(({ box, leaves }, i) => {
        const side = box.x > layout.center.x ? ["right", "left"] : ["left", "right"];
        const branch = canvas.addText({ text: branchTexts[i], ...box });
        canvas.addEdge({ from: center, to: branch, fromSide: side[0], toSide: side[1] });
        leaves.forEach((leafBox, j) => {
          const leaf = canvas.addFile({ file: perItem[i][j], ...leafBox });
          canvas.addEdge({ from: branch, to: leaf, fromSide: side[0], toSide: side[1] });
        });
      });
      addFurtherReading(
        canvas,
        notes.map((n) => n.path).filter((p) => !placed.has(p)),
        [layout.center, ...layout.branches.flatMap((b) => [b.box, ...b.leaves])]
      );

      const path = save("說明", map.title || topic, canvas);
      return { path, title: map.title, summary: map.summary, usedNotes: [...placed] };
    },

    /**
     * 規劃圖：每個階段一個群組框（由上往下），階段內步驟由左到右、依序連線（跨階段也接起來），
     * 步驟引用的筆記卡掛在步驟下方。
     * @returns {{ path, title, summary, usedNotes: string[] }}
     */
    async plan(goal) {
      const notes = await gatherNotes(goal);
      const { raw: map, onlyKnown } = await askWithNotes({
        topic: goal,
        notes,
        tool: PLAN_TOOL,
        system: "你在幫使用者把一個目標整理成分階段、可以照著做的規劃圖。步驟要具體可執行。",
      });
      let stepsLeft = MAX_STEPS;
      const phases = (map.phases || [])
        .slice(0, MAX_PHASES)
        .map((ph) => {
          const steps = (ph.steps || []).slice(0, Math.max(0, stepsLeft)).map((s) => ({
            title: String(s.title || "").trim(),
            detail: String(s.detail || "").trim(),
            notes: onlyKnown(s.notes),
          }));
          stepsLeft -= steps.length;
          return { title: String(ph.title || "").trim(), steps };
        })
        .filter((ph) => ph.steps.length);

      const allSteps = phases.flatMap((ph) => ph.steps);
      // 節點預算：標題卡 + 每個階段的群組框 + 步驟 + 延伸閱讀卡，剩下的給筆記卡
      const { perItem, placed } = allocateLeaves(
        allSteps.map((s) => s.notes),
        MAX_CANVAS_NODES - 1 - phases.length - allSteps.length - 1
      );

      const headerText = `# ${map.title}\n\n${map.summary}`;
      const stepText = (s) => (s.detail ? `**${s.title}**\n\n${s.detail}` : `**${s.title}**`);
      let k = 0;
      const layout = flowLayout({
        header: textCardSize(headerText, 600),
        phases: phases.map((ph) => ({
          steps: ph.steps.map((s) => ({ size: textCardSize(stepText(s), 320), leaves: perItem[k++].map(() => FILE_CARD) })),
        })),
      });

      const canvas = createCanvas();
      const header = canvas.addText({ text: headerText, color: "6", ...layout.header });
      let previous = header;
      k = 0;
      layout.phases.forEach(({ group, steps }, p) => {
        canvas.addGroup({ label: phases[p].title, ...group });
        steps.forEach(({ box, leaves }, i) => {
          const step = canvas.addText({ text: stepText(phases[p].steps[i]), ...box });
          const sameRow = previous !== header && i > 0;
          canvas.addEdge({ from: previous, to: step, fromSide: sameRow ? "right" : "bottom", toSide: sameRow ? "left" : "top" });
          previous = step;
          leaves.forEach((leafBox, j) => {
            const leaf = canvas.addFile({ file: perItem[k][j], ...leafBox });
            canvas.addEdge({ from: step, to: leaf, fromSide: "bottom", toSide: "top" });
          });
          k++;
        });
      });
      addFurtherReading(
        canvas,
        notes.map((n) => n.path).filter((p) => !placed.has(p)),
        [layout.header, ...layout.phases.map((ph) => ph.group)]
      );

      const path = save("規劃", map.title || goal, canvas);
      return { path, title: map.title, summary: map.summary, usedNotes: [...placed] };
    },

    /**
     * 關聯圖：相關的筆記與概念卡依資料夾分群；vault 既有的關係畫成無標籤的線，
     * AI 判斷的關係畫成彩色、帶標籤的線（同一對已有既有關係時升級成帶標籤，不重複畫）。
     * 檔名依主題固定（Canvas/關聯/<主題> 關聯圖.canvas）；已經有這張圖就增量更新（見 canvasMerge.js），不覆蓋使用者的調整。
     * @returns {{ path, title, summary, usedNotes: string[] }}
     */
    async relate(topic) {
      const catalog = buildCatalog(vault);
      const path = `${CANVAS_ROOT}/關聯/${titleToFilename(`${topic} 關聯圖`)}.canvas`;
      const oldRaw = vault.readFile(path);
      let old = null;
      if (oldRaw !== null) {
        try {
          old = JSON.parse(oldRaw);
        } catch {
          throw new Error(`${path} 不是有效的 canvas（可能手動改壞了），修好或刪掉再試一次`);
        }
      }
      const allPicks = await selectRelevantNotes(ai, catalog, topic, { max: MAX_RELATION_NOTES });
      // 節點上限：中心 + 群組框 + 筆記 + 延伸閱讀；超過就把最不相關的（挑選順序最後的）移到延伸閱讀
      const groupCount = (paths) => new Set(paths.map((p) => (p.startsWith("卡片/") ? CARD_GROUP : folderOf(p)))).size;
      let picks = allPicks;
      while (picks.length && 1 + groupCount(picks) + picks.length + 1 > MAX_CANVAS_NODES) picks = picks.slice(0, -1);
      const notes = picks.map((p) => vault.readNote(p));
      const known = new Set(picks);
      const brief = notes.map((n) => `【${n.path}】${n.title}：${(n.summary || n.body).replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
      const map = await ai.askJson({
        system:
          "你在幫使用者畫筆記之間的關聯圖。只連真的有意義的關係，標籤要具體（例如：依賴、比較、延伸、實作、前置知識）。" +
          "from / to 只能填提供的筆記路徑。用繁體中文。",
        user: `主題：${topic}\n\n筆記：\n${brief || "（沒有相關筆記）"}`,
        tool: RELATE_TOOL,
      });

      // 合併兩種關係：同一對以 AI 的標籤為準
      const edges = new Map();
      for (const r of existingRelations(notes)) edges.set(pairKey(r.from, r.to), { ...r });
      if (old) {
        // 既有關係也看舊圖上的筆記，新筆記才連得到它們
        const onCanvas = (old.nodes || []).filter((n) => n.type === "file" && vault.readFile(n.file) !== null).map((n) => n.file);
        const extra = onCanvas.filter((p) => !known.has(p)).map((p) => vault.readNote(p));
        for (const r of existingRelations([...notes, ...extra])) if (!edges.has(pairKey(r.from, r.to))) edges.set(pairKey(r.from, r.to), { ...r });
      }

      for (const r of map.relations || []) {
        if (!known.has(r.from) || !known.has(r.to) || r.from === r.to || !r.label) continue;
        edges.set(pairKey(r.from, r.to), { from: r.from, to: r.to, label: String(r.label).trim(), color: AI_RELATION_COLOR });
      }
      if (old) return updateRelationCanvas({ path, old, catalog, picks: allPicks, edges, title: map.title || topic });

      // 依資料夾分群（概念卡一群），群的順序依第一篇被挑中的順序（越相關越前面）
      const clusters = new Map();
      for (const n of notes) {
        const label = n.frontmatter?.type === "card" ? CARD_GROUP : folderOf(n.path);
        if (!clusters.has(label)) clusters.set(label, []);
        clusters.get(label).push(n.path);
      }
      const labels = [...clusters.keys()];
      const centerText = `# ${map.title || topic}\n\n${map.summary || ""}`;
      const layout = clusterLayout({
        center: textCardSize(centerText, 500),
        clusters: labels.map((l) => clusters.get(l).map(() => FILE_CARD)),
      });

      const canvas = createCanvas();
      canvas.addText({ text: centerText, color: "6", ...layout.center });
      const nodeOf = new Map();
      layout.clusters.forEach(({ group, items }, i) => {
        canvas.addGroup({ label: labels[i], ...group });
        items.forEach((box, j) => {
          const file = clusters.get(labels[i])[j];
          nodeOf.set(file, canvas.addFile({ file, ...box }));
        });
      });
      // 同一群裡的既有連結不畫：同資料夾的筆記本來就互相連「相關筆記」，畫出來會糊成一團，群組框已經表達了這層關係
      const groupOf = new Map(labels.flatMap((l) => clusters.get(l).map((p) => [p, l])));
      const drawn = [...edges.values()].filter((e) => e.label || groupOf.get(e.from) !== groupOf.get(e.to));
      for (const e of drawn) canvas.addEdge({ from: nodeOf.get(e.from), to: nodeOf.get(e.to), label: e.label, color: e.color });
      addFurtherReading(canvas, allPicks.slice(picks.length), [layout.center, ...layout.clusters.map((c) => c.group)]);

      vault.writeFile(path, `${JSON.stringify(canvas.toJSON(), null, 2)}\n`);
      const aiCount = drawn.filter((e) => e.label).length;
      return {
        path,
        title: map.title || topic,
        summary: `${map.summary || ""}（${drawn.length} 條關係，其中 ${aiCount} 條由 AI 判斷）`.trim(),
        usedNotes: picks,
      };
    },

    /**
     * 研究總覽：找出相關的研究筆記（/notebook 做的），每篇一列三欄：研究問題與研究筆記 → 研究角度 → 來源（概念卡、引用網址）。
     * 研究角度與來源直接從研究筆記擷取，AI 只負責挑出相關的研究。
     * @returns {{ path, title, summary, usedNotes: string[] }}
     */
    async research(topic) {
      const catalog = buildCatalog(vault).filter((c) => c.kind === "research");
      const picks = catalog.length ? await selectRelevantNotes(ai, catalog, topic, { max: 5 }) : [];
      if (!picks.length) {
        throw new Error(
          `vault 裡找不到跟「${topic}」相關的研究筆記。想做新的研究用 /notebook ${topic}；只想整理既有筆記用 /canvas 說明 ${topic}`
        );
      }
      const shown = picks.slice(0, MAX_RESEARCH_SHOWN).map((p) => ({ path: p, outline: researchOutline(vault.readNote(p)) }));

      const rows = shown.map(({ path: notePath, outline }) => {
        const questionText = `# ${outline.question}`;
        const angleTexts = outline.angles.slice(0, MAX_ANGLES).map((a) => `**${a}**`);
        const cards = outline.cards.filter((c) => vault.readFile(c) !== null).slice(0, MAX_SOURCES);
        const urls = outline.urls.slice(0, MAX_SOURCES - cards.length);
        return { notePath, questionText, angleTexts, cards, urls };
      });
      const layout = columnsLayout({
        rows: rows.map((r) => ({
          columns: [
            [textCardSize(r.questionText, 420), FILE_CARD],
            r.angleTexts.map((t) => textCardSize(t, 340)),
            [...r.cards.map(() => FILE_CARD), ...r.urls.map(() => ({ width: 400, height: 140 }))],
          ],
        })),
      });

      const canvas = createCanvas();
      layout.rows.forEach(({ group, columns: [left, middle, right] }, i) => {
        const r = rows[i];
        canvas.addGroup({ label: `研究：${vault.readNote(r.notePath).title}`, ...group });
        const question = canvas.addText({ text: r.questionText, color: "6", ...left[0] });
        canvas.addFile({ file: r.notePath, ...left[1] });
        middle.forEach((box, j) => {
          const angle = canvas.addText({ text: r.angleTexts[j], ...box });
          canvas.addEdge({ from: question, to: angle, fromSide: "right", toSide: "left" });
        });
        right.forEach((box, j) => {
          if (j < r.cards.length) canvas.addFile({ file: r.cards[j], ...box });
          else canvas.addLink({ url: r.urls[j - r.cards.length], ...box });
        });
      });
      addFurtherReading(canvas, picks.slice(MAX_RESEARCH_SHOWN), layout.rows.map((r) => r.group));

      // 檔名用研究筆記的標題（研究問題通常是一長句，當檔名太長）
      const title = `${vault.readNote(shown[0].path).title} 研究總覽`;
      const path = save("研究", title, canvas);
      const summary = rows.map((r) => `${vault.readNote(r.notePath).title}：${r.angleTexts.length} 個研究角度`).join("；");
      return { path, title, summary, usedNotes: rows.map((r) => r.notePath) };
    },
  };
}
