import { Telegraf } from "telegraf";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, NOTEBOOKLM_ENABLED, NOTEBOOKLM_COMMAND } from "./config.js";
import { answerFromVault } from "./askVault.js";
import { notebook, pipeline } from "./app.js";
import { createTaskQueue } from "./taskQueue.js";
import { renderFolderView, renderNoteView, resolveBrowseToken } from "./browseView.js";

function isAllowed(userId) {
  // 白名單留空 = 不限制任何人（見啟動時的警告訊息）
  if (TELEGRAM_ALLOWED_USER_IDS.length === 0) return true;
  return TELEGRAM_ALLOWED_USER_IDS.includes(userId);
}

// 一般內容跟 /notebook 研究存檔完成後共用的回覆內容。extraLines 會插在標題下面（例如研究主題）。
function formatSavedReply(
  header,
  { draft, result, notebookId, relatedResult, mocResult, gitResult, fetchErrors = [], warnings = [], createdTags = [], cards = [] },
  extraLines = []
) {
  const gitLine = !gitResult?.attempted || gitResult.skipped // 沒設定 VAULT_GIT_REMOTE、或沒有新異動可 commit
    ? null
    : gitResult.pushed
      ? "🔄 已同步到 Git"
      : `⚠️ Git 同步失敗：${gitResult.error || "未知錯誤"}（筆記已正常存進 Obsidian，只是還沒推上 git）`;

  return [
    header,
    ...fetchErrors.map(({ url, error }) => `⚠️ 抓不到原文，只依網址與留言整理：${url}（${error}）`),
    ...warnings.map((w) => `⚠️ ${w}`),
    ...extraLines,
    `標題：${draft.title}`,
    `資料夾：${draft.folder}`,
    `檔名：${result.relativePath}`,
    draft.summary ? `摘要：${draft.summary}` : null,
    draft.tags?.length ? draft.tags.map((t) => `#${t}`).join(" ") : null,
    createdTags.length ? `🆕 新 tag：${createdTags.join("、")}（已加入 _系統/tags.json，要合併成既有 tag 可在那裡加別名）` : null,
    notebookId ? `📓 NotebookLM notebook id：${notebookId}` : null,
    cards.length
      ? `🃏 概念卡：${cards.map((card) => (card.created ? `${card.name}（新）` : card.name)).join("、")}`
      : null,
    relatedResult?.linkedCount ? `🔗 已跟 ${relatedResult.linkedCount} 篇既有筆記互相補上關聯連結` : null,
    mocResult?.updated ? `🗺️ 已更新「${mocResult.mocPath}」分類地圖` : null,
    gitLine,
  ]
    .filter(Boolean)
    .join("\n");
}

// 改寫同一則「處理中」訊息的內容（狀態更新、完成、失敗都用這個）。
function editStatus(ctx, msg, text) {
  return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text).catch((err) => {
    console.warn(`[telegram] 更新訊息失敗：${err.message}`);
  });
}

// 幫處理中的訊息掛上持續的「正在輸入...」動畫，回傳一個 stop() 可以在處理完後呼叫清掉計時器。
function startTypingLoop(ctx) {
  ctx.sendChatAction("typing").catch(() => {});
  const timer = setInterval(() => {
    ctx.sendChatAction("typing").catch(() => {});
  }, 4000);
  return () => clearInterval(timer);
}

// Telegraf 的 polling 會等「這一批 update 的 handler 全部跑完」才去抓下一批，
// handler 裡 await 長任務（抓網頁、AI 整理、研究）會讓整個 bot 卡住、後面的指令都收不到。
// 所以長任務一律丟到背景（不 await），handler 立刻返回。
function inBackground(task) {
  task().catch((err) => console.error("[telegram] 背景任務失敗", err));
}

// 一般內容跟 /notebook 各自一條 lane（見 taskQueue.js），兩條可以同時跑。
const intakeLane = createTaskQueue();
const researchLane = createTaskQueue();

/**
 * 把長任務排進 lane：立刻回覆排隊位置或「開始處理」，輪到它時換成處理中訊息並顯示打字動畫，
 * 完成或失敗時發一則新訊息（回覆使用者原本那則，會推播），並刪掉中間的狀態訊息。
 * run(statusMsg) 可以拿 statusMsg 即時改寫進度（例如 NotebookLM 自動重新登入）。
 */
async function runQueued(ctx, lane, { startText, run, formatDone, failPrefix }) {
  const ahead = lane.size();
  const statusMsg = await ctx.reply(
    ahead > 0 ? `📋 已收到，排第 ${ahead + 1} 個（前面還有 ${ahead} 個），輪到時會開始處理，完成後通知你。` : startText
  );
  const replyToUser = { reply_parameters: { message_id: ctx.message.message_id } };

  inBackground(async () => {
    let stopTyping = () => {};
    try {
      const outcome = await lane.enqueue(() => run(statusMsg), {
        onStart: async () => {
          stopTyping = startTypingLoop(ctx);
          if (ahead > 0) await editStatus(ctx, statusMsg, startText);
        },
      });
      await ctx.reply(formatDone(outcome), replyToUser);
    } catch (err) {
      console.error(err);
      await ctx.reply(`${failPrefix}：${String(err?.message || err)}`, replyToUser);
    } finally {
      stopTyping();
      await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
    }
  });
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

  // 長任務都在背景跑（見 inBackground / runQueued），handler 本身很快就返回，
  // 用 Telegraf 預設的 handlerTimeout 即可；真正的逾時保護在各個 CLI 呼叫裡。
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
        "想看目前有哪些分類、點進去瀏覽文章，用 /browse。",
        NOTEBOOKLM_ENABLED
          ? "想針對一個主題做真正的網路研究（不是查現有筆記，是查新資料），用 /notebook 加上主題，例如：\n/notebook 台灣離岸風電現況"
          : null,
      ]
        .filter(Boolean)
        .join("\n")
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

    // 查詢不排隊（不會被一般收件或研究擋住），但一樣在背景跑，不卡住 polling。
    const processingMsg = await ctx.reply("🔍 正在從筆記庫裡查詢...");
    inBackground(async () => {
      const stopTyping = startTypingLoop(ctx);
      try {
        const { answer, matchedCount } = await answerFromVault(question);
        const footer = matchedCount > 0 ? `\n\n（搜尋了 ${matchedCount} 篇相關筆記）` : "";
        await editStatus(ctx, processingMsg, `${answer}${footer}`);
      } catch (err) {
        console.error(err);
        await editStatus(ctx, processingMsg, `❌ 查詢失敗：${String(err?.message || err)}`);
      } finally {
        stopTyping();
      }
    });
  });

  // /notebook <主題>：不是查現有筆記（那是 /ask），而是用 NotebookLM 針對主題做真正的
  // 網路研究，產生一份帶引用來源的報告，再照平常的分類規則寫成一篇新筆記存進 vault。
  bot.command("notebook", async (ctx) => {
    const topic = ctx.message.text.replace(/^\/notebook(@\w+)?\s*/, "").trim();

    if (!NOTEBOOKLM_ENABLED) {
      await ctx.reply(
        `⚠️ 找不到「${NOTEBOOKLM_COMMAND}」指令，/notebook 功能還不能用。\n` +
          "要先在這台電腦上安裝 notebooklm-py CLI 並登入，步驟見 README「用 NotebookLM 做深度研究」。"
      );
      return;
    }

    if (!topic) {
      await ctx.reply("用法：/notebook 研究主題，例如：\n/notebook 台灣離岸風電現況");
      return;
    }

    await runQueued(ctx, researchLane, {
      startText: `🧪 開始用 NotebookLM 研究「${topic}」，依複雜度可能要幾分鐘，請稍候...`,
      run: (statusMsg) =>
        pipeline.processNotebookResearch(topic, "telegram-notebook", {
          // 登入過期時 notebookResearch.js 會自動嘗試 refresh / login 重新登入，
          // 每個步驟的狀態即時改到狀態訊息上，讓使用者知道不是卡住。
          onStatus: (text) => editStatus(ctx, statusMsg, text),
        }),
      formatDone: (outcome) => formatSavedReply("✅ 研究完成，已存進 Obsidian", outcome, [`主題：${topic}`]),
      failPrefix: `❌ 研究「${topic}」失敗`,
    });
  });

  // /notebooklm_login：伺服器跑著的時候也能直接觸發 `notebooklm login`，不用另外開終端機。
  // 這是互動式 OAuth 流程，會在「跑這個 node 服務的那台機器」上跳出瀏覽器視窗，
  // 所以只適合本機/自己電腦上跑的情境；stdout/stderr 完整轉貼回 Telegram 方便照著網址操作。
  bot.command("notebooklm_login", async (ctx) => {
    if (!NOTEBOOKLM_ENABLED) {
      await ctx.reply(`⚠️ 找不到「${NOTEBOOKLM_COMMAND}」指令，請先安裝 notebooklm-py CLI（見 README）。`);
      return;
    }

    const msg = await ctx.reply("🔑 正在執行 notebooklm login，跑這個服務的機器上應該會跳出瀏覽器登入畫面，請稍候...");

    // 要等使用者在瀏覽器裡完成登入（最多 5 分鐘），在背景等，不卡住其他指令。
    inBackground(async () => {
      try {
        const output = await notebook.login();
        await editStatus(ctx, msg, `✅ 登入完成\n\n${output.trim().slice(-3000) || "(無輸出)"}`);
      } catch (err) {
        await editStatus(ctx, msg, `❌ 登入失敗：${err.message}`);
      }
    });
  });

  // /browse：列出目前 vault 裡的分類（vault 根目錄下的資料夾），可以用按鈕一路點下去查
  // 子分類，最後點進某篇筆記看內容預覽。純瀏覽、不會新增或修改任何筆記。
  bot.command("browse", async (ctx) => {
    const { text, keyboard } = renderFolderView([]);
    await ctx.reply(text, keyboard);
  });

  // /browse 的按鈕：bf = 切換到某個資料夾、bp = 同資料夾換一頁筆記、bn = 點進某篇筆記看內容預覽。
  const browseActions = [
    [/^bf\|(.+)$/, (segments) => renderFolderView(segments)],
    [/^bp\|([^|]+)\|(\d+)$/, (segments, match) => renderFolderView(segments, Number(match[2]))],
    [/^bn\|(.+)$/, (segments) => renderNoteView(segments)],
  ];
  for (const [pattern, render] of browseActions) {
    bot.action(pattern, async (ctx) => {
      const segments = resolveBrowseToken(ctx.match[1]);
      if (segments === null) {
        await ctx.answerCbQuery("這個按鈕過期了，請重新 /browse 一次", { show_alert: true }).catch(() => {});
        return;
      }
      try {
        const { text, keyboard } = render(segments, ctx.match);
        await ctx.editMessageText(text, keyboard).catch(() => {});
        await ctx.answerCbQuery().catch(() => {});
      } catch (err) {
        console.error(err);
        await ctx.answerCbQuery(`讀取失敗：${String(err?.message || err)}`, { show_alert: true }).catch(() => {});
      }
    });
  }

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // 忽略其他指令

    await runQueued(ctx, intakeLane, {
      startText: "🔎 收到，處理中...",
      run: () => pipeline.processIncomingContent(text, "telegram"),
      formatDone: (outcome) =>
        outcome.duplicate
          ? [
              "📎 這篇文章已經存過了，沒有建立新筆記。",
              `既有筆記：${outcome.duplicatePath}`,
              "如果確定要重複建立，把連結後面加個字或不同網址再丟一次即可。",
            ].join("\n")
          : formatSavedReply("✅ 已存進 Obsidian", outcome),
      failPrefix: "❌ 處理失敗",
    });
  });

  bot.catch((err) => console.error("[telegram] bot error", err));

  // 設定 Telegram 選單（在聊天輸入框打 / 會跳出的指令清單）：只列出「現在真的能用」的指令——
  // 例如沒裝 notebooklm CLI 時，/notebook 就不會出現在選單裡，避免選了才發現用不了
  // （指令本身還是能用打字的方式呼叫，只是不會被 Telegram 建議）。
  const menuCommands = [
    { command: "ask", description: "從已存筆記查資料（不會新增筆記）" },
    { command: "browse", description: "瀏覽目前的分類，往下查詢文章" },
    ...(NOTEBOOKLM_ENABLED
      ? [{ command: "notebook", description: "用 NotebookLM 做研究，存進 Obsidian" }]
      : []),
    { command: "whoami", description: "查詢自己的 Telegram user ID" },
  ];
  // Telegram 的指令選單分「scope」（default / all_private_chats / 特定聊天...），
  // 優先權由窄到寬：只設 default 的話，如果這個 bot 之前透過 @BotFather 或別的程式
  // 用 all_private_chats（或更窄的 scope）設過選單，那份會蓋過我們這裡設的、
  // 私訊裡看到的還是舊選單。這支 bot 只在私訊裡用，這裡把 default 跟
  // all_private_chats 兩個 scope 都設成一樣的清單，確保私訊選單一定被蓋過去。
  const commandScopes = [{ type: "default" }, { type: "all_private_chats" }];
  Promise.all(
    commandScopes.map((scope) =>
      bot.telegram.setMyCommands(menuCommands, { scope }).catch((err) => {
        console.warn(`[telegram] 設定指令選單失敗（scope: ${scope.type}）：${err.message}`);
        throw err;
      })
    )
  )
    .then(() => {
      console.log(`[telegram] 已設定指令選單：${menuCommands.map((c) => `/${c.command}`).join("、")}`);
    })
    .catch(() => {
      // 個別 scope 的失敗已經各自印過 warning，這裡不用再印一次。
    });

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
