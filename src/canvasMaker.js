import { createCanvas, textCardSize } from "./canvasWriter.js";
import { mindMapLayout, flowLayout, columnsLayout } from "./canvasLayout.js";
import { buildCatalog, selectRelevantNotes } from "./vaultCatalog.js";
import { titleToFilename, wikiLink } from "./noteStore.js";

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

  // 同名不覆蓋：說明/規劃/研究圖是一次性產出，再產生一次就另存新檔
  function save(kind, title, canvas) {
    const base = `${CANVAS_ROOT}/${kind}/${titleToFilename(title)}`;
    let path = `${base}.canvas`;
    for (let n = 2; vault.readFile(path) !== null; n++) path = `${base} (${n}).canvas`;
    vault.writeFile(path, `${JSON.stringify(canvas.toJSON(), null, 2)}\n`);
    return path;
  }

  return {
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
