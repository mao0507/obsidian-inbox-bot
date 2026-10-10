// /notebook 的研究計畫：真正開始研究（可能跑半小時）之前，先把使用者模糊的需求整理成
// 「一個研究問題 + 3~5 個研究角度」，在 Telegram 給使用者確認或修改。
// 確認後的計畫決定 NotebookLM 要研究什麼（add-research 的查詢）與報告的章節（見 notebookResearch.buildReportPrompt）。

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
    },
    required: ["question", "angles"],
  },
};

const SYSTEM = `你是研究規劃助理。使用者想用 NotebookLM 做深度網路研究，原始需求可能很簡短、模糊，或只是一個網址。
請整理成一份研究計畫：一個具體的研究問題，加上 3~5 個研究角度（之後會變成研究報告的章節）。
- 使用者有附網址時，以網址內容為研究核心，角度圍繞它展開。
- 使用者有給修改意見時，以修改意見為最優先。
- 用繁體中文。`;

/**
 * @param {{ topic: string, sources?: Array<{url, ok, title?, text?}>, previous?: {question, angles}, feedback?: string }} input
 */
export function buildPlanPrompts({ topic, sources = [], previous, feedback }) {
  const sourceBlock = sources
    .filter((s) => s.ok)
    .map((s) => `【${s.url}】\n標題：${s.title || ""}\n${(s.text || "").slice(0, 2000)}`)
    .join("\n\n");
  const revision = previous
    ? `\n\n目前的計畫：\n研究問題：${previous.question}\n研究角度：\n${previous.angles
        .map((a, i) => `${i + 1}. ${a}`)
        .join("\n")}\n\n使用者的修改意見：${feedback || "（無）"}\n請依修改意見調整計畫。`
    : "";
  return {
    system: SYSTEM,
    user: `使用者的研究需求：\n${topic}${sourceBlock ? `\n\n附帶網址的內容（節錄）：\n${sourceBlock}` : ""}${revision}`,
  };
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
  return `研究問題：${plan.question}\n\n研究角度：\n${plan.angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
}
