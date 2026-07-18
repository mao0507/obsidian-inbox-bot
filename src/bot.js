import { Telegraf } from "telegraf";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS } from "./config.js";
import { processIncomingContent } from "./pipeline.js";
import { answerFromVault } from "./askVault.js";

function isAllowed(userId) {
  // 白名單留空 = 不限制任何人（見啟動時的警告訊息）
  if (TELEGRAM_ALLOWED_USER_IDS.length === 0) return true;
  return TELEGRAM_ALLOWED_USER_IDS.includes(userId);
}

function formatGitStatusLine(gitResult) {
  if (!gitResult || !gitResult.attempted) return null; // 沒設定 VAULT_GIT_REMOTE，不顯示這行
  if (gitResult.pushed) return "🔄 已同步到 Git";
  if (gitResult.skipped) return null; // 沒有新異動可 commit，沒什麼好講的
  return `⚠️ Git 同步失敗：${gitResult.error || "未知錯誤"}（筆記已正常存進 Obsidian，只是還沒推上 git）`;
}

function formatEagleStatusLine(eagleResult) {
  if (!eagleResult || !eagleResult.attempted) return null; // 沒啟用 Eagle 或這篇沒有圖片，不顯示這行
  if (eagleResult.synced) return `🖼️ 已存 ${eagleResult.count} 張圖片到 Eagle`;
  return `⚠️ Eagle 圖片同步失敗：${eagleResult.error || "未知錯誤"}（筆記已正常存進 Obsidian，只是圖片沒進 Eagle）`;
}

function formatEagleGitStatusLine(eagleGitResult) {
  if (!eagleGitResult || !eagleGitResult.attempted) return null; // 沒設定 EAGLE_GIT_REMOTE 或這篇沒有圖片，不顯示這行
  if (eagleGitResult.pushed) {
    const failedNote = eagleGitResult.failed ? `，${eagleGitResult.failed} 張下載失敗` : "";
    return `📦 已備份 ${eagleGitResult.downloaded} 張圖片到 Eagle 圖片 git${failedNote}`;
  }
  if (eagleGitResult.skipped) return null; // 沒有新異動可 commit
  return `⚠️ Eagle 圖片備份到 git 失敗：${eagleGitResult.error || "未知錯誤"}`;
}

function formatEmbedStatusLine(embedResult) {
  if (!embedResult) return null;
  const filenames = embedResult.filenames || [];
  const failed = embedResult.failed || 0;
  if (filenames.length === 0 && failed === 0) return null; // 沒有圖片可內嵌，不顯示這行
  if (filenames.length > 0) {
    const failedNote = failed ? `，${failed} 張下載失敗` : "";
    return `🖼️ 已內嵌 ${filenames.length} 張圖片到筆記${failedNote}`;
  }
  return `⚠️ 圖片內嵌失敗（${failed} 張全部下載失敗）`;
}

function formatRelatedStatusLine(relatedResult) {
  if (!relatedResult || !relatedResult.linkedCount) return null;
  return `🔗 已跟 ${relatedResult.linkedCount} 篇既有筆記互相補上關聯連結`;
}

function formatMocStatusLine(mocResult) {
  if (!mocResult || !mocResult.updated) return null;
  return `🗺️ 已更新「${mocResult.mocPath}」分類地圖`;
}

// 幫處理中的訊息掛上持續的「正在輸入...」動畫，回傳一個 stop() 可以在處理完後呼叫清掉計時器。
function startTypingLoop(ctx) {
  ctx.sendChatAction("typing").catch(() => {});
  const timer = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4000);
  return () => clearInterval(timer);
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

  // 權限檢查放在最前面的 middleware，沒過的話後面的 bot.start / bot.command / bot.on('text') 都不會執行。
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
      [
        "嗨！直接傳文字、想法或網址給我，我會自動分類整理，寫進你的 Obsidian vault。",
        "想從已經存進去的筆記裡查資料，用 /ask 加上你的問題，例如：",
        "/ask 北海道有什麼景點",
      ].join("\n")
    )
  );

  // /whoami、/id：查自己的 Telegram user ID，方便設定白名單。
  bot.command(["whoami", "id"], (ctx) => ctx.reply(`你的 Telegram user ID 是：${ctx.from.id}`));

  // /ask <問題>：不寫新筆記，改成從現有筆記庫裡找資料回答問題。
  bot.command("ask", async (ctx) => {
    const question = ctx.message.text.replace(/^\/ask(@\w+)?\s*/, "").trim();
    if (!question) {
      await ctx.reply("用法：/ask 你的問題，例如：\n/ask 北海道有什麼景點");
      return;
    }

    const processingMsg = await ctx.reply("🔍 正在從筆記庫裡查詢...");
    const stopTyping = startTypingLoop(ctx);

    try {
      const { answer, matchedCount } = await answerFromVault(question);
      const footer = matchedCount > 0 ? `\n\n（搜尋了 ${matchedCount} 篇相關筆記）` : "";
      await ctx.telegram.editMessageText(ctx.chat.id, processingMsg.message_id, undefined, `${answer}${footer}`);
    } catch (err) {
      console.error(err);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `❌ 查詢失敗：${String(err?.message || err)}`
      );
    } finally {
      stopTyping();
    }
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // 忽略其他指令

    const processingMsg = await ctx.reply("🔎 收到，處理中...");

    // Telegram 的「正在輸入...」動畫大概只會維持約 5 秒就自動消失，
    // Notion 頁面這種長時間處理（可能到 20~30 秒）要每隔幾秒重送一次才會全程顯示。
    const stopTyping = startTypingLoop(ctx);

    try {
      const {
        duplicate,
        duplicatePath,
        draft,
        result,
        gitResult,
        eagleResult,
        eagleGitResult,
        embedResult,
        relatedResult,
        mocResult,
      } = await processIncomingContent(text, "telegram");

      if (duplicate) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          [
            "📎 這篇文章已經存過了，沒有建立新筆記。",
            `既有筆記：${duplicatePath}`,
            "如果確定要重複建立，把連結後面加個字或不同網址再丟一次即可。",
          ].join("\n")
        );
        return;
      }

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
          formatEmbedStatusLine(embedResult),
          formatEagleStatusLine(eagleResult),
          formatEagleGitStatusLine(eagleGitResult),
          formatRelatedStatusLine(relatedResult),
          formatMocStatusLine(mocResult),
          formatGitStatusLine(gitResult),
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
      stopTyping();
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
