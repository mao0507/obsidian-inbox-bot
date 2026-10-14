// /canvas：用 Obsidian Canvas 畫說明圖、規劃圖、研究總覽（之後加上關聯圖）。
// 產生要 1~2 分鐘（AI 挑筆記 + 整理結構），排進一般收件佇列（會寫入 vault）。
// Telegram 點不開 obsidian:// 連結，回覆檔案路徑，在 Obsidian 用快速切換（Ctrl+O）貼上開啟。

// 類型 -> canvasMaker 的方法與說明
const KINDS = {
  說明: { method: "explain", hint: "把主題整理成心智圖，連到相關筆記", example: "/canvas 說明 Vue 的響應式怎麼運作" },
  規劃: { method: "plan", hint: "把目標整理成分階段的流程圖", example: "/canvas 規劃 北海道 5 天行程" },
  研究: { method: "research", hint: "把相關的 NotebookLM 研究畫成「研究問題 → 角度 → 來源」", example: "/canvas 研究 grill-me" },
};

const USAGE = [
  "用法：",
  ...Object.entries(KINDS).map(([kind, k]) => `/canvas ${kind} 主題 —— ${k.hint}\n  例如：${k.example}`),
].join("\n");

function formatResult(kind, { path, title, summary, usedNotes }) {
  return [
    `🗺️ 已產生${kind}圖：${title}`,
    summary,
    "",
    `用了 ${usedNotes.length} 篇筆記${usedNotes.length ? "" : "（vault 裡沒有相關筆記，內容依一般知識整理）"}`,
    `檔案：${path}`,
    "在 Obsidian 按 Ctrl+O（手機用搜尋）貼上檔名即可開啟。",
  ].join("\n");
}

/**
 * @param {import("telegraf").Telegraf} bot
 * @param {{ canvasMaker, intakeLane, runQueued: Function }} deps
 */
export function registerCanvasCommands(bot, { canvasMaker, intakeLane, runQueued }) {
  bot.command("canvas", async (ctx) => {
    const args = ctx.message.text.replace(/^\/canvas(@\w+)?\s*/, "").trim();
    const [kind, ...rest] = args.split(/\s+/);
    const topic = rest.join(" ").trim();
    const spec = KINDS[kind];

    if (!spec || !topic) {
      await ctx.reply(USAGE);
      return;
    }

    await runQueued(ctx, intakeLane, {
      startText: `🗺️ 整理「${topic}」的${kind}圖中（找相關筆記、整理結構，大約 1~2 分鐘）...`,
      run: () => canvasMaker[spec.method](topic),
      formatDone: (result) => formatResult(kind, result),
      failPrefix: `❌ 產生${kind}圖失敗`,
    });
  });
}
