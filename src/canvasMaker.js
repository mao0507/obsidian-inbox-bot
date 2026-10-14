import { createCanvas, textCardSize } from "./canvasWriter.js";
import { mindMapLayout } from "./canvasLayout.js";
import { buildCatalog, selectRelevantNotes } from "./vaultCatalog.js";
import { titleToFilename, wikiLink } from "./noteStore.js";

// /canvas：從 vault 找出跟主題相關的筆記，請 AI 整理成結構，再排版寫成 Obsidian Canvas。
// 文字卡負責「說明」（AI 寫的重點），筆記卡負責「出處」（指向既有筆記，可在 Obsidian 直接預覽、點進去）。
// 一張圖最多 MAX_CANVAS_NODES 個節點，放不下的筆記列在「延伸閱讀」文字卡，避免手機上看不清楚。

export const MAX_CANVAS_NODES = 30;
const CANVAS_ROOT = "Canvas";
const MAX_BRANCHES = 6;
const NOTE_BODY_CHARS = 3000;
const FILE_CARD = { width: 400, height: 260 };
const BRANCH_WIDTH = 380;

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
            points: { type: "array", items: { type: "string" }, description: "2~4 個重點，每個一句完整的話" },
            notes: { type: "array", items: { type: "string" }, description: "支持這個分支的筆記路徑（原樣照抄提供的路徑）" },
          },
          required: ["title", "points", "notes"],
        },
      },
    },
    required: ["title", "summary", "branches"],
  },
};

const bullet = (items) => items.map((p) => `- ${p}`).join("\n");

export function createCanvasMaker({ vault, ai }) {
  // 挑出相關筆記並讀內文；focusPath（回覆某篇筆記時）一定放在第一個
  async function gatherNotes(topic, { focusPath } = {}) {
    const picks = await selectRelevantNotes(ai, buildCatalog(vault), topic);
    const paths = focusPath ? [focusPath, ...picks.filter((p) => p !== focusPath)] : picks;
    return paths.map((p) => vault.readNote(p));
  }

  const notesBlock = (notes) =>
    notes.map((n) => `【${n.path}】${n.title}\n${n.body.slice(0, NOTE_BODY_CHARS)}`).join("\n\n---\n\n");

  // 同名不覆蓋：說明/規劃/研究圖是一次性產出，再產生一次就另存新檔
  function uniqueCanvasPath(kind, title) {
    const base = `${CANVAS_ROOT}/${kind}/${titleToFilename(title)}`;
    let candidate = `${base}.canvas`;
    for (let n = 2; vault.readFile(candidate) !== null; n++) candidate = `${base} (${n}).canvas`;
    return candidate;
  }

  return {
    /**
     * 說明圖：中心是主題摘要，往外是各面向（重點文字卡），每個面向連到支持它的筆記卡。
     * @returns {{ path, title, summary, usedNotes: string[] }}
     */
    async explain(topic, { focusPath } = {}) {
      const notes = await gatherNotes(topic, { focusPath });
      const known = new Set(notes.map((n) => n.path));
      const map = await ai.askJson({
        system:
          "你在幫使用者把一個主題整理成說明用的心智圖，只能根據提供的筆記內容，不要編造筆記沒提到的事。" +
          "每個分支的 notes 只能填提供的筆記路徑。用繁體中文。",
        user: `主題：${topic}\n\n相關筆記：\n${notesBlock(notes) || "（vault 裡沒有相關筆記，依一般知識整理，notes 留空）"}`,
        tool: EXPLAIN_TOOL,
      });

      const branches = (map.branches || []).slice(0, MAX_BRANCHES).map((b) => ({
        title: String(b.title || "").trim(),
        points: (b.points || []).filter(Boolean),
        notes: [...new Set((b.notes || []).filter((p) => known.has(p)))],
      }));

      // 節點預算：中心 + 分支 + 延伸閱讀卡，剩下的給筆記卡。各分支輪流分配（不會一個分支吃光預算），
      // 同一篇筆記只出現一次。
      let budget = MAX_CANVAS_NODES - 1 - branches.length - 1;
      const placed = new Set();
      const leavesPerBranch = branches.map(() => []);
      let progressed = true;
      while (budget > 0 && progressed) {
        progressed = false;
        branches.forEach((b, i) => {
          const next = b.notes.find((p) => !placed.has(p));
          if (budget > 0 && next) {
            leavesPerBranch[i].push(next);
            placed.add(next);
            budget--;
            progressed = true;
          }
        });
      }
      const furtherReading = notes.map((n) => n.path).filter((p) => !placed.has(p));

      const centerText = `# ${map.title}\n\n${map.summary}`;
      const branchTexts = branches.map((b) => `## ${b.title}\n\n${bullet(b.points)}`);
      const layout = mindMapLayout({
        center: textCardSize(centerText, 440),
        branches: branches.map((_, i) => ({
          size: textCardSize(branchTexts[i], BRANCH_WIDTH),
          leaves: leavesPerBranch[i].map(() => FILE_CARD),
        })),
      });

      const canvas = createCanvas();
      const center = canvas.addText({ text: centerText, color: "6", ...layout.center });
      layout.branches.forEach(({ box, leaves }, i) => {
        const right = box.x > layout.center.x;
        const branch = canvas.addText({ text: branchTexts[i], ...box });
        canvas.addEdge({ from: center, to: branch, fromSide: right ? "right" : "left", toSide: right ? "left" : "right" });
        leaves.forEach((leafBox, j) => {
          const leaf = canvas.addFile({ file: leavesPerBranch[i][j], ...leafBox });
          canvas.addEdge({ from: branch, to: leaf, fromSide: right ? "right" : "left", toSide: right ? "left" : "right" });
        });
      });

      if (furtherReading.length) {
        const text = `## 延伸閱讀\n\n${furtherReading.map((p) => `- ${wikiLink(p)}`).join("\n")}`;
        const allBoxes = [layout.center, ...layout.branches.flatMap((b) => [b.box, ...b.leaves])];
        const bottom = Math.max(...allBoxes.map((b) => b.y + b.height));
        const size = textCardSize(text, 440);
        canvas.addText({ text, x: -size.width / 2, y: bottom + 120, ...size });
      }

      const path = uniqueCanvasPath("說明", map.title || topic);
      vault.writeFile(path, `${JSON.stringify(canvas.toJSON(), null, 2)}\n`);
      return { path, title: map.title, summary: map.summary, usedNotes: [...placed] };
    },
  };
}
