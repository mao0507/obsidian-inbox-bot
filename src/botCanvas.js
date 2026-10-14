// /canvas：用 Obsidian Canvas 畫說明圖、規劃圖、關聯圖、研究總覽。
// 產生要 1~2 分鐘（AI 挑筆記 + 整理結構），排進一般收件佇列（會寫入 vault）。
// Telegram 點不開 obsidian:// 連結，回覆檔案路徑，在 Obsidian 用快速切換（Ctrl+O）貼上開啟。

import { basenameOf } from "./noteStore.js";

// 類型 -> canvasMaker 的方法與說明
const KINDS = {
  說明: { method: "explain", hint: "把主題整理成心智圖，連到相關筆記", example: "/canvas 說明 Vue 的響應式怎麼運作" },
  規劃: { method: "plan", hint: "把目標整理成分階段的流程圖", example: "/canvas 規劃 北海道 5 天行程" },
  關聯: { method: "relate", hint: "相關筆記與概念卡的關聯圖（依資料夾分群、標出關係）", example: "/canvas 關聯 Vue" },
  研究: { method: "research", hint: "把相關的 NotebookLM 研究畫成「研究問題 → 角度 → 來源」", example: "/canvas 研究 grill-me" },
};

const USAGE = [
  "用法：",
  "/canvas 問題 —— 不指定類型，AI 判斷畫哪一種",
  "  例如：/canvas Vue 響應式怎麼運作",
  "回覆一則「已存進 Obsidian」的訊息傳 /canvas —— 針對那篇筆記畫說明圖",
  ...Object.entries(KINDS).map(([kind, k]) => `/canvas ${kind} 主題 —— ${k.hint}\n  例如：${k.example}`),
].join("\n");

const kindOfMethod = (method) => Object.keys(KINDS).find((k) => KINDS[k].method === method);

// 存筆記的回覆訊息裡有「檔名：<路徑>」，回覆那則訊息就知道是哪篇筆記（不用另外記狀態，重啟後也有效）
export function notePathOfReply(message) {
  const match = /^檔名：(.+.md)$/m.exec(message?.text || "");
  return match ? match[1].trim() : null;
}

function formatResult(kind, { path, title, summary, usedNotes }, { auto = false } = {}) {
  return [
    `🗺️ 已產生${kind}圖：${title}`,
    auto ? `（AI 判斷適合畫成${kind}圖；想指定類型用 /canvas ${Object.keys(KINDS).join("|")} 主題）` : null,
    summary,
    "",
    `用了 ${usedNotes.length} 篇筆記${usedNotes.length ? "" : "（vault 裡沒有相關筆記，內容依一般知識整理）"}`,
    `檔案：${path}`,
    "在 Obsidian 按 Ctrl+O（手機用搜尋）貼上檔名即可開啟。",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * @param {import("telegraf").Telegraf} bot
 * @param {{ canvasMaker, intakeLane, runQueued: Function }} deps
 */
export function registerCanvasCommands(bot, { canvasMaker, intakeLane, runQueued }) {
  const queue = (ctx, kind, topic, run, { auto = false, kindOf = () => kind } = {}) =>
    runQueued(ctx, intakeLane, {
      startText: `🗺️ 整理「${topic}」的${kind}圖中（找相關筆記、整理結構，大約 1~2 分鐘）...`,
      run,
      formatDone: (result) => formatResult(kindOf(), result, { auto }),
      failPrefix: `❌ 產生${kind}圖失敗`,
    });

  bot.command("canvas", async (ctx) => {
    const args = ctx.message.text.replace(/^\/canvas(@\w+)?\s*/, "").trim();
    const [kind, ...rest] = args.split(/\s+/);
    const topic = rest.join(" ").trim();
    const focusPath = notePathOfReply(ctx.message.reply_to_message);

    // 回覆筆記訊息：針對那篇筆記畫說明圖（後面有字就當主題，沒有就用筆記標題）
    if (focusPath && (!KINDS[kind] || KINDS[kind].method === "explain")) {
      const subject = (KINDS[kind] ? topic : args) || basenameOf(focusPath);
      await queue(ctx, "說明", subject, () => canvasMaker.explain(subject, { focusPath }));
      return;
    }
    if (KINDS[kind] && topic) {
      await queue(ctx, kind, topic, () => canvasMaker[KINDS[kind].method](topic));
      return;
    }
    if (!args || KINDS[kind]) {
      await ctx.reply(USAGE);
      return;
    }
    // 沒指定類型：先判斷再畫（判斷也在佇列裡做，不卡住 bot）
    let picked = "說明";
    await queue(
      ctx,
      "",
      args,
      async () => {
        const method = await canvasMaker.pickKind(args);
        picked = kindOfMethod(method);
        return canvasMaker[method](args);
      },
      { auto: true, kindOf: () => picked }
    );
  });
}
