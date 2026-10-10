// /notebook 的研究計畫：真正開始研究（可能跑半小時）之前，先把使用者模糊的需求整理成
// 「一個研究問題 + 3~5 個研究角度」，在 Telegram 給使用者確認或修改。
// 確認後的計畫決定 NotebookLM 要研究什麼（add-research 的查詢）與報告的章節（見 notebookResearch.buildReportPrompt）。
// 規劃時也會比對 vault 裡的既有研究，主題相同就讓使用者選擇「補充到既有筆記」，避免同一主題研究好幾份。

export const RESEARCH_PLAN_TOOL = {
  name: "research_plan",
  description: "把使用者的研究需求整理成一份研究計畫",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "一句話的研究問題，具體、可以直接拿去做網路研究（繁體中文，30 字以內）",
      },
      angles: {
        type: "array",
        items: { type: "string" },
        description: "3~5 個研究角度，每個是報告的一個章節，彼此不重疊、涵蓋使用者最可能想知道的面向（每個 20 字以內）",
      },
      existing_match: {
        type: "string",
        description: "「既有研究」清單裡跟這次主題實質相同的那一篇的路徑（原樣照抄）；沒有相同主題的就填空字串",
      },
    },
    required: ["question", "angles"],
  },
};

const SYSTEM = `你是研究規劃助理。使用者想用 NotebookLM 做深度網路研究，原始需求可能很簡短、模糊，或只是一個網址。
請整理成一份研究計畫：一個具體的研究問題，加上 3~5 個研究角度（之後會變成研究報告的章節）。
- 使用者有附網址時，以網址內容為研究核心，角度圍繞它展開。
- 使用者有給修改意見時，以修改意見為最優先。
- 「既有研究」清單裡如果有主題實質相同的研究（只是說法不同也算），existing_match 填那篇的路徑；只是相關但主題不同就不要填。
- 用繁體中文。`;

const numbered = (items) => items.map((item, i) => `${i + 1}. ${item}`).join("\n");

/**
 * @param {{ topic: string, sources?: Array<{url, ok, title?, text?}>, previous?: {question, angles},
 *           feedback?: string, existingResearch?: Array<{path, title, topic}> }} input
 */
export function buildPlanPrompts({ topic, sources = [], previous, feedback, existingResearch = [] }) {
  const parts = [`使用者的研究需求：\n${topic}`];
  const okSources = sources.filter((s) => s.ok);
  if (okSources.length) {
    parts.push(
      `附帶網址的內容（節錄）：\n${okSources
        .map((s) => `【${s.url}】\n標題：${s.title || ""}\n${(s.text || "").slice(0, 2000)}`)
        .join("\n\n")}`
    );
  }
  if (existingResearch.length) {
    parts.push(
      `既有研究（vault 裡已經做過的研究筆記）：\n${existingResearch
        .map((r) => `- ${r.path}（主題：${r.topic || r.title}）`)
        .join("\n")}`
    );
  }
  if (previous) {
    parts.push(
      `目前的計畫：\n研究問題：${previous.question}\n研究角度：\n${numbered(previous.angles)}\n\n` +
        `使用者的修改意見：${feedback || "（無）"}\n請依修改意見調整計畫。`
    );
  }
  return { system: SYSTEM, user: parts.join("\n\n") };
}

/** 檢查 AI 給的計畫能不能用；不能用就丟錯（讓使用者重試或改寫需求）。 */
export function validatePlan(plan) {
  const question = String(plan?.question || "").trim();
  const angles = (Array.isArray(plan?.angles) ? plan.angles : []).map((a) => String(a).trim()).filter(Boolean);
  if (!question) throw new Error("研究計畫缺少研究問題，請再試一次或把需求寫具體一點");
  if (angles.length < 2) throw new Error("研究計畫的研究角度太少，請再試一次或把需求寫具體一點");
  return { question, angles: angles.slice(0, 5) };
}

/** Telegram 顯示用 */
export function formatPlan(plan) {
  const existing = plan.existing ? `\n\n📚 已有相關研究：${plan.existing.title}（${plan.existing.path}）` : "";
  return `研究問題：${plan.question}\n\n研究角度：\n${numbered(plan.angles)}${existing}`;
}

const NOTEBOOK_ID = /notebook[ _]?id[^0-9a-f]{0,6}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** 研究筆記對應的 NotebookLM notebook id：新筆記在 frontmatter，舊筆記只寫在正文裡。 */
export function notebookIdOf(note) {
  return note.frontmatter?.notebook_id || note.body.match(NOTEBOOK_ID)?.[1] || null;
}

/** vault 裡的研究筆記（新的 type: research，或舊的 via: telegram-notebook / claude-code-skill）。 */
export function researchNotesIn(vault) {
  return vault
    .listNotes()
    .filter(
      (n) => n.frontmatter?.type === "research" || /^(telegram-notebook|claude-code-skill)$/.test(n.frontmatter?.via || "")
    )
    .map((n) => ({ path: n.path, title: n.title, topic: n.frontmatter?.topic || "", notebookId: notebookIdOf(n) }));
}

// ---- 舊研究筆記重建：同主題分組 ----

export const RESEARCH_GROUP_TOOL = {
  name: "research_groups",
  description: "把研究筆記依主題分組，每組附一份研究計畫",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "每一組是主題實質相同的研究筆記（只有一篇的主題也自成一組），每篇筆記只能出現在一組",
        items: {
          type: "object",
          properties: {
            paths: { type: "array", items: { type: "string" }, description: "這組筆記的路徑（原樣照抄）" },
            question: { type: "string", description: "這組的研究問題（繁體中文，30 字以內）" },
            angles: { type: "array", items: { type: "string" }, description: "3~5 個研究角度，涵蓋這組各篇筆記關注的面向" },
          },
          required: ["paths", "question", "angles"],
        },
      },
    },
    required: ["groups"],
  },
};

export function buildGroupPrompts(notes) {
  return {
    system:
      "你在整理使用者的研究筆記庫。同一個主題常被研究了好幾次（標題說法不同），請把主題實質相同的筆記分在同一組，" +
      "並為每組寫一份研究計畫（研究問題 + 研究角度），之後會依計畫把這組合併成一份更完整的研究。用繁體中文。",
    user: `研究筆記清單：\n${notes.map((n) => `- ${n.path}（標題：${n.title}）`).join("\n")}`,
  };
}

/**
 * 整理 AI 的分組：只收清單裡的路徑、每篇只出現一次；AI 漏掉的筆記各自成一組（研究問題用標題）。
 * @returns {Array<{ oldPaths: string[], question: string, angles: string[] }>}
 */
export function normalizeGroups(raw, notes) {
  const known = new Map(notes.map((n) => [n.path, n]));
  const used = new Set();
  const groups = [];
  for (const group of raw?.groups || []) {
    const oldPaths = (group.paths || []).filter((p) => known.has(p) && !used.has(p)).sort();
    if (!oldPaths.length) continue;
    oldPaths.forEach((p) => used.add(p));
    const angles = (group.angles || []).map((a) => String(a).trim()).filter(Boolean).slice(0, 5);
    groups.push({ oldPaths, question: String(group.question || "").trim() || known.get(oldPaths[0]).title, angles });
  }
  for (const note of notes) {
    if (!used.has(note.path)) groups.push({ oldPaths: [note.path], question: note.title, angles: [] });
  }
  return groups.sort((a, b) => (a.oldPaths[0] < b.oldPaths[0] ? -1 : 1));
}
