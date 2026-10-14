// /canvas：用 Obsidian Canvas 畫說明圖（之後加上關聯、規劃、研究總覽）。
// 產生要 1~2 分鐘（AI 挑筆記 + 整理結構），排進一般收件佇列（會寫入 vault）。
// Telegram 點不開 obsidian:// 連結，回覆檔案路徑，在 Obsidian 用快速切換（Ctrl+O）貼上開啟。

const USAGE = ["用法：", "/canvas 說明 主題 —— 把主題整理成心智圖，連到相關筆記", "例如：/canvas 說明 Vue 的響應式怎麼運作"].join("\n");

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

    if (kind !== "說明" || !topic) {
      await ctx.reply(USAGE);
      return;
    }

    await runQueued(ctx, intakeLane, {
      startText: `🗺️ 整理「${topic}」的說明圖中（找相關筆記、整理重點，大約 1~2 分鐘）...`,
      run: () => canvasMaker.explain(topic),
      formatDone: (result) => formatResult("說明", result),
      failPrefix: "❌ 產生說明圖失敗",
    });
  });
}
