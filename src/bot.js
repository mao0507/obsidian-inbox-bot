import { Telegraf } from "telegraf";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS } from "./config.js";
import { processIncomingContent } from "./pipeline.js";

function isAllowed(userId) {
  // 白名單留空 = 不限制任何人（見啟動時的警告訊息）
  if (TELEGRAM_ALLOWED_USER_IDS.length === 0) return true;
  return TELEGRAM_ALLOWED_USER_IDS.includes(userId);
}

export function startBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[telegram] 沒有設定 TELEGRAM_BOT_TOKEN，略過啟動 Telegram bot");
    return;
  }

  if (TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    console.warn(
      "[telegram] ⚠️ 沒有設定 TELEGRAM_ALLOWED_USER_IDS，任何人只要知道這個 bot 都能傳訊息、觸發分類！建議盡快在 .env 設定白名單（見 README）。"
    );
  } else {
    console.log(`[telegram] 白名單已啟用，只有 ${TELEGRAM_ALLOWED_USER_IDS.length} 個 user ID 能使用這個 bot`);
  }

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  // 權限檢查放在最前面的 middleware，沒過的話後面的 bot.start / bot.on('text') 都不會執行。
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (isAllowed(userId)) {
      return next();
    }
    console.warn(`[telegram] 拒絕未授權的使用者：user_id=${userId} username=${ctx.from?.username || "(無)"}`);
    await ctx.reply(
      [
        "🚫 你沒有使用這個 bot 的權限。",
        `你的 Telegram user ID 是：${userId}`,
        "如果這是你自己的 bot，把這個 ID 加進 .env 的 TELEGRAM_ALLOWED_USER_IDS 就能用了。",
      ].join("\n")
    );
  });

  bot.start((ctx) =>
    ctx.reply(
      "嗨！直接傳文字、想法或網址給我，我會自動分類整理，寫進你的 Obsidian vault。"
    )
  );

  // /whoami、/id：查自己的 Telegram user ID，方便設定白名單。
  // 這兩個指令也是走上面的 middleware，未授權的人一樣會被擋下（並且已經在上面的回覆裡看到自己的 ID 了）。
  bot.command(["whoami", "id"], (ctx) => ctx.reply(`你的 Telegram user ID 是：${ctx.from.id}`));

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // 忽略其他指令

    const processingMsg = await ctx.reply("🔎 收到，處理中...");

    // Telegram 的「正在輸入...」動畫大概只會維持約 5 秒就自動消失，
    // Notion 頁面這種長時間處理（可能到 20~30 秒）要每隔幾秒重送一次才會全程顯示。
    await ctx.sendChatAction("typing").catch(() => {});
    const typingTimer = setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4000);

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
    } finally {
      clearInterval(typingTimer);
    }
  });

  bot.catch((err) => console.error("[telegram] bot error", err));

  bot.launch().catch((err) => {
    if (err?.response?.error_code === 409) {
      console.error(
        "[telegram] ❌ 啟動失敗：Telegram 說已經有另一個程式在用同一個 bot token 收訊息了" +
          "（error 409 Conflict）。這代表電腦上還有別的 npm start / node 在跑同一支 bot，" +
          "常見情況是另一個終端機視窗還開著沒關。請把其他跑這支 bot 的程式都關掉，再重新啟動這一個。" +
          "Telegram bot 這部分目前沒有運作，但網頁版不受影響。"
      );
      return;
    }
    console.error("[telegram] bot 啟動失敗", err);
  });
  console.log("[telegram] bot 已啟動（polling 模式）");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
