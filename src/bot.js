import { Telegraf, Markup } from "telegraf";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, NOTEBOOKLM_ENABLED, NOTEBOOKLM_COMMAND } from "./config.js";
import { processIncomingContent, processNotebookResearch } from "./pipeline.js";
import { answerFromVault } from "./askVault.js";
import { enqueueTask, queuePendingCount, isProcessing } from "./taskQueue.js";
import { listFolder, readNote } from "./vaultBrowser.js";

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

function formatRelatedStatusLine(relatedResult) {
  if (!relatedResult || !relatedResult.linkedCount) return null;
  return `🔗 已跟 ${relatedResult.linkedCount} 篇既有筆記互相補上關聯連結`;
}

function formatMocStatusLine(mocResult) {
  if (!mocResult || !mocResult.updated) return null;
  return `🗺️ 已更新「${mocResult.mocPath}」分類地圖`;
}

function formatNotebookIdLine(notebookId) {
  if (!notebookId) return null;
  return `📓 NotebookLM notebook id：${notebookId}`;
}

// /browse 用的導覽狀態：Telegram inline button 的 callback_data 上限 64 bytes，
// 中文路徑（例如 "AI/ClaudeCode/教學文章"）動不動就超過，沒辦法把完整路徑塞進去，
// 所以改成「產生一個短 token 對應到實際路徑片段陣列」，callback_data 只帶 token。
// 純記憶體對照表，bot 重啟會清空（沒關係，舊按鈕原本就會失效，使用者重新 /browse 即可）；
// 用陣列額外記住插入順序，超過上限就從最舊的開始丟，避免長時間跑下來無限長大。
const BROWSE_TOKEN_LIMIT = 3000;
const browseTokens = new Map();
const browseTokenOrder = [];
let browseTokenSeq = 0;

function makeBrowseToken(segments) {
  const token = (browseTokenSeq++).toString(36);
  browseTokens.set(token, segments);
  browseTokenOrder.push(token);
  if (browseTokenOrder.length > BROWSE_TOKEN_LIMIT) {
    const oldest = browseTokenOrder.shift();
    browseTokens.delete(oldest);
  }
  return token;
}

function resolveBrowseToken(token) {
  return browseTokens.get(token) ?? null;
}

const BROWSE_NOTES_PAGE_SIZE = 8;
const BROWSE_LABEL_MAX_LEN = 40;

function truncateLabel(name) {
  return name.length > BROWSE_LABEL_MAX_LEN ? `${name.slice(0, BROWSE_LABEL_MAX_LEN - 1)}…` : name;
}

// 畫出某個分類（資料夾）目前的子分類 + 直接放在這一層的筆記，回傳文字內容跟 inline keyboard。
// segments=[] 代表分類總覽（vault 根目錄下的所有頂層分類）。
function renderFolderView(segments, notesPage = 0) {
  const { subfolders, notes } = listFolder(segments);
  const label = segments.join(" / ");
  const totalNotes = notes.length + subfolders.reduce((sum, f) => sum + f.noteCount, 0);

  const lines = [segments.length ? `📂 ${label}（共 ${totalNotes} 篇筆記）` : `📚 目前的分類（共 ${totalNotes} 篇筆記）`];
  if (!subfolders.length && !notes.length) {
    lines.push("這裡目前是空的。");
  } else if (subfolders.length) {
    lines.push("點下面的按鈕繼續往下查詢子分類或文章：");
  }

  const rows = [];
  for (const folder of subfolders) {
    const token = makeBrowseToken(folder.segments);
    rows.push([Markup.button.callback(`📁 ${truncateLabel(folder.name)}（${folder.noteCount}）`, `bf|${token}`)]);
  }

  const pageStart = notesPage * BROWSE_NOTES_PAGE_SIZE;
  const pageNotes = notes.slice(pageStart, pageStart + BROWSE_NOTES_PAGE_SIZE);
  for (const note of pageNotes) {
    const token = makeBrowseToken(note.segments);
    rows.push([Markup.button.callback(`📄 ${truncateLabel(note.name)}`, `bn|${token}`)]);
  }

  if (notes.length > BROWSE_NOTES_PAGE_SIZE) {
    const folderToken = makeBrowseToken(segments);
    const pagerRow = [];
    if (notesPage > 0) pagerRow.push(Markup.button.callback("⬅️ 上一頁", `bp|${folderToken}|${notesPage - 1}`));
    if (pageStart + BROWSE_NOTES_PAGE_SIZE < notes.length) {
      pagerRow.push(Markup.button.callback("下一頁 ➡️", `bp|${folderToken}|${notesPage + 1}`));
    }
    if (pagerRow.length) rows.push(pagerRow);
  }

  const navRow = [];
  if (segments.length > 0) {
    const parentToken = makeBrowseToken(segments.slice(0, -1));
    navRow.push(Markup.button.callback("⬅️ 上一層", `bf|${parentToken}`));
    const rootToken = makeBrowseToken([]);
    navRow.push(Markup.button.callback("🏠 分類總覽", `bf|${rootToken}`));
  }
  if (navRow.length) rows.push(navRow);

  return { text: lines.join("\n"), keyboard: Markup.inlineKeyboard(rows) };
}

// 畫出單篇筆記的詳細內容（標題、摘要、標籤、路徑、內文預覽）跟一個返回分類的按鈕。
function renderNoteView(segments) {
  const note = readNote(segments);
  const relPath = segments.join("/");
  const bodyPreview =
    note.body && note.body.length > 800 ? `${note.body.slice(0, 800)}…\n\n（內容太長，完整版請到 Obsidian 打開）` : note.body;

  const lines = [
    `📄 ${note.title || relPath}`,
    note.summary ? `摘要：${note.summary}` : null,
    note.tags?.length ? note.tags.map((t) => `#${t}`).join(" ") : null,
    `路徑：${relPath}`,
    "",
    bodyPreview || "（沒有內文）",
  ].filter((line) => line !== null);

  const parentToken = makeBrowseToken(segments.slice(0, -1));
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback("⬅️ 返回分類", `bf|${parentToken}`)]]);

  return { text: lines.join("\n"), keyboard };
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

  // Telegraf 預設每個指令 handler 執行超過 90 秒（handlerTimeout 預設值）就會被它自己
  // 判定逾時、印出 TimeoutError（不是真的把 handler 砍掉，只是它自己放棄追蹤、當成錯誤記一筆）。
  // /notebook 的研究流程本來就常常超過 90 秒（deep 模式甚至可能到半小時），
  // 這裡關掉 Telegraf 這層自己的逾時判定——真正的逾時保護已經在 notebookResearch.js
  // 裡針對每個 notebooklm 子指令分別設好了（RESEARCH_TIMEOUT_MS、REPORT_TIMEOUT_MS 等），
  // 不需要 Telegraf 再疊加一層更短的逾時。
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN, { handlerTimeout: Infinity });

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

    // 排隊位置：如果現在有任務正在跑，這則新任務至少要等它跑完；
    // pending 是「還沒開始執行」的既有任務數，兩者加起來才是這則新任務前面總共有幾個。
    const aheadCount = queuePendingCount() + (isProcessing() ? 1 : 0);
    const processingMsg = await ctx.reply(
      aheadCount > 0
        ? `📋 已加入研究佇列（前面還有 ${aheadCount} 個任務在排隊），輪到你的時候會開始處理，完成後會通知你。`
        : `🧪 開始用 NotebookLM 研究「${topic}」，依複雜度可能要幾分鐘，請稍候...`
    );

    let stopTyping = () => {};

    try {
      const { draft, result, notebookId, gitResult, relatedResult, mocResult } = await enqueueTask(
        () => processNotebookResearch(topic, "telegram-notebook"),
        {
          onStart: async () => {
            stopTyping = startTypingLoop(ctx);
            // 排隊時發過一則「已加入佇列」的訊息，真正輪到它開始跑的時候換成處理中的訊息；
            // 沒排隊、直接開始執行的話上面那則本來就已經是這句了，不用重複編輯。
            if (aheadCount > 0) {
              await ctx.telegram
                .editMessageText(
                  ctx.chat.id,
                  processingMsg.message_id,
                  undefined,
                  `🧪 開始用 NotebookLM 研究「${topic}」，依複雜度可能要幾分鐘，請稍候...`
                )
                .catch(() => {});
            }
          },
        }
      );

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        [
          "✅ 研究完成，已存進 Obsidian",
          `主題：${topic}`,
          `標題：${draft.title}`,
          `資料夾：${draft.folder}`,
          `檔名：${result.relativePath}`,
          draft.summary ? `摘要：${draft.summary}` : null,
          draft.tags?.length ? draft.tags.map((t) => `#${t}`).join(" ") : null,
          formatNotebookIdLine(notebookId),
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
        `❌ 研究失敗：${String(err?.message || err)}`
      );
    } finally {
      stopTyping();
    }
  });

  // /browse：列出目前 vault 裡的分類（vault 根目錄下的資料夾），可以用按鈕一路點下去查
  // 子分類，最後點進某篇筆記看內容預覽。純瀏覽、不會新增或修改任何筆記。
  bot.command("browse", async (ctx) => {
    const { text, keyboard } = renderFolderView([]);
    await ctx.reply(text, keyboard);
  });

  // bf = browse folder：切換到某個資料夾的畫面（子分類 + 直接放在這層的筆記第一頁）。
  bot.action(/^bf\|(.+)$/, async (ctx) => {
    const segments = resolveBrowseToken(ctx.match[1]);
    if (segments === null) {
      await ctx.answerCbQuery("這個按鈕過期了，請重新 /browse 一次", { show_alert: true }).catch(() => {});
      return;
    }
    const { text, keyboard } = renderFolderView(segments);
    await ctx.editMessageText(text, keyboard).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  });

  // bp = browse page：同一個資料夾，換一頁筆記清單。
  bot.action(/^bp\|([^|]+)\|(\d+)$/, async (ctx) => {
    const segments = resolveBrowseToken(ctx.match[1]);
    if (segments === null) {
      await ctx.answerCbQuery("這個按鈕過期了，請重新 /browse 一次", { show_alert: true }).catch(() => {});
      return;
    }
    const { text, keyboard } = renderFolderView(segments, Number(ctx.match[2]));
    await ctx.editMessageText(text, keyboard).catch(() => {});
    await ctx.answerCbQuery().catch(() => {});
  });

  // bn = browse note：點進某篇筆記看內容預覽。
  bot.action(/^bn\|(.+)$/, async (ctx) => {
    const segments = resolveBrowseToken(ctx.match[1]);
    if (segments === null) {
      await ctx.answerCbQuery("這個按鈕過期了，請重新 /browse 一次", { show_alert: true }).catch(() => {});
      return;
    }
    try {
      const { text, keyboard } = renderNoteView(segments);
      await ctx.editMessageText(text, keyboard).catch(() => {});
      await ctx.answerCbQuery().catch(() => {});
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery(`讀取筆記失敗：${String(err?.message || err)}`, { show_alert: true }).catch(() => {});
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
      const { duplicate, duplicatePath, draft, result, gitResult, relatedResult, mocResult } =
        await processIncomingContent(text, "telegram");

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
