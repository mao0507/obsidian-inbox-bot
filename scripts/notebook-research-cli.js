// 讓 Claude Code（或任何命令列）可以直接觸發一次 NotebookLM 研究，跟 Telegram 的
// /notebook 指令走完全同一套邏輯（src/pipeline.js 的 processNotebookResearch）：
// 網址會先加為保證來源、理解內容，一般文字主題會先用本機 Claude CLI/API 摘要成
// 清楚的研究說明，研究完的報告會照平常的分類規則寫進 Obsidian vault。
//
// 用法：node scripts/notebook-research-cli.js <研究主題或網址>
// 例如：node scripts/notebook-research-cli.js "https://www.youtube.com/watch?v=xxxxxxxxxxx"
//      node scripts/notebook-research-cli.js 台灣離岸風電現況
//
// 主要是給 .claude/skills/notebook-research/SKILL.md 呼叫用，讓 Claude Code
// 也能觸發跟 Telegram bot 一樣的研究流程，不需要另外跑 Telegram。
// 依主題複雜度、研究模式（NOTEBOOKLM_RESEARCH_MODE），這支腳本可能要跑幾十秒到
// 幾十分鐘，執行時請耐心等待，不要中途取消。
import { processNotebookResearch } from "../src/pipeline.js";
import { NOTEBOOKLM_ENABLED, NOTEBOOKLM_COMMAND } from "../src/config.js";

const topic = process.argv.slice(2).join(" ").trim();

if (!NOTEBOOKLM_ENABLED) {
  console.error(
    `❌ 找不到「${NOTEBOOKLM_COMMAND}」指令，還沒安裝/登入 notebooklm-py CLI。` +
      `安裝步驟見 README「用 NotebookLM 做深度研究」。`
  );
  process.exit(1);
}

if (!topic) {
  console.error('用法：node scripts/notebook-research-cli.js "<研究主題或網址>"');
  process.exit(1);
}

function printResult(topicInput, outcome) {
  const { draft, result, notebookId, gitResult, relatedResult, mocResult } = outcome;
  const lines = [
    "",
    "================ 研究完成，已存進 Obsidian ================",
    `主題：${topicInput}`,
    `標題：${draft.title}`,
    `資料夾：${draft.folder}`,
    `檔名：${result.relativePath}`,
  ];
  if (draft.summary) lines.push(`摘要：${draft.summary}`);
  if (draft.tags?.length) lines.push(`標籤：${draft.tags.map((t) => `#${t}`).join(" ")}`);
  if (notebookId) lines.push(`NotebookLM notebook id：${notebookId}`);
  if (relatedResult?.linkedCount) lines.push(`已補 ${relatedResult.linkedCount} 篇關聯連結`);
  if (mocResult?.updated) lines.push(`已更新分類地圖：${mocResult.mocPath}`);
  if (gitResult?.attempted) {
    lines.push(gitResult.pushed ? "已同步到 git" : `⚠️ git 同步失敗：${gitResult.error || "未知錯誤"}（筆記已正常存進 vault）`);
  }
  lines.push("=============================================================");
  console.log(lines.join("\n"));
}

try {
  const outcome = await processNotebookResearch(topic, "claude-code-skill");
  printResult(topic, outcome);
  process.exit(0);
} catch (err) {
  console.error(`❌ 研究失敗：${err?.message || err}`);
  process.exit(1);
}
