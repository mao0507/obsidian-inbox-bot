import { Telegraf } from "telegraf";
import { TELEGRAM_BOT_TOKEN } from "./config.js";
import { processIncomingContent } from "./pipeline.js";

export function startBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[telegram] 沒有設定 TELEGRAM_BOT_TOKEN，略過啟動 Telegram bot");
    return;
  }

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) =>
    ctx.reply(
      "嗨！直接傳文字、想法或網址給我，我會自動分類整理，寫進你的 Obsidian vault。"
    )
  );

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // 忽略其他指令

    const processingMsg = await ctx.reply("🔎 收到，處理中...");

    try {
      const { draft, result } = await processIncomingContent(text, "telegram");
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        [
          "✅ 已存進 Obsidian",
          `標題：${draft.title}`,
          `資料夾：${draft.folder}`,
          `檔名：${result.relativePath}`,
          draft.summary ? `摘要：${draft.summary}` : null,
          draft.tags?.length ? draft.tags.map((t) => `#${t}`).join(" ") : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (err) {
      console.error(err);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `❌ 處理失敗：${String(err?.message || err)}`
      );
    }
  });

  bot.catch((err) => console.error("[telegram] bot error", err));

  bot.launch();
  console.log("[telegram] bot 已啟動（polling 模式）");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
