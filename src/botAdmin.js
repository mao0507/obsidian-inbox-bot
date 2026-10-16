import fs from "node:fs";
import { TAXONOMY } from "./taxonomy.js";
import { selfUpdate } from "./selfUpdate.js";

// 管理類 Telegram 指令：/status、/sync、/logs、/restart、/update、/migrate。
// 讓不在電腦前（沒開專案、不能下 pnpm 指令）的時候也能查狀態、同步、看 log、重啟、處理舊筆記重建。
// 這支不 import config / app：依賴由 bot.js 傳進來；文字格式化是純函式，有測試。

const LOG_LINES = 30;
const TELEGRAM_TEXT_LIMIT = 3900; // 訊息上限 4096，留點餘裕給標題

export function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小時`;
  if (hours) return `${hours} 小時 ${minutes} 分`;
  if (minutes) return `${minutes} 分`;
  return `${s} 秒`;
}

/** 檔案最後 n 行；檔案不存在回傳 null。 */
export function tailLines(file, n) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

function vaultCounts(vault) {
  const counts = new Map();
  for (const note of vault.listNotes()) {
    if (note.frontmatter?.type === "MOC") continue;
    const top = note.path.split("/")[0];
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  // 分類樹的順序在前，其他資料夾（卡片、舊分類）在後
  const order = [...Object.keys(TAXONOMY), "卡片"];
  return [...counts]
    .sort(([a], [b]) => {
      const ia = order.indexOf(a) === -1 ? Infinity : order.indexOf(a);
      const ib = order.indexOf(b) === -1 ? Infinity : order.indexOf(b);
      return ia - ib || a.localeCompare(b, "zh-Hant");
    })
    .map(([top, n]) => `${top} ${n}`)
    .join("、");
}

export function formatMigrationStatus(state) {
  if (!state) return "還沒開始舊筆記重建（第一次請在電腦執行 pnpm run migrate plan）";
  const groups = state.researchGroups || [];
  const researchIds = new Set(groups.map((g) => g.oldPaths[0]));
  const generalDone = Object.keys(state.done).filter((id) => !researchIds.has(id)).length;
  const researchDone = groups.filter((g) => state.done[g.oldPaths[0]]).length;
  const failed = Object.entries(state.failed || {});
  return [
    `一般筆記：${generalDone} 組完成`,
    groups.length ? `研究筆記：${researchDone}/${groups.length} 組完成` : null,
    state.finalizedAt ? `上次收尾：${state.finalizedAt.slice(0, 16).replace("T", " ")}` : "尚未收尾",
    ...failed.map(([id, error]) => `❌ ${id}：${String(error).slice(0, 150)}`),
    failed.length ? "重跑失敗的組：/migrate retry；先收尾已完成的組：/migrate finalize" : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatStatus({ vault, uptimeSec, underPm2, lanes, tools, migrationState }) {
  const flag = (ok) => (ok ? "✅" : "❌");
  return [
    "📊 目前狀態",
    `bot：已執行 ${formatUptime(uptimeSec)}${underPm2 ? "（pm2）" : "（非 pm2，/restart 不會自動重啟）"}`,
    `佇列：一般收件 ${lanes.intake} 個、研究 ${lanes.research} 個（含執行中）`,
    `vault：${vaultCounts(vault)}`,
    `工具：NotebookLM ${flag(tools.notebooklm)}　yt-dlp ${flag(tools.ytdlp)}`,
    "",
    "🔁 舊筆記重建",
    formatMigrationStatus(migrationState),
  ].join("\n");
}

const gitLine = (r) =>
  !r?.attempted ? "沒有設定 VAULT_GIT_REMOTE，vault 沒有同步到 git" : r.skipped ? "沒有新的異動" : r.pushed ? "🔄 已同步到 git" : `⚠️ 同步失敗：${r.error}`;

/**
 * @param {import("telegraf").Telegraf} bot
 * @param {object} deps
 * @param {object} deps.vault
 * @param {object} deps.migration  migration.js 的 createMigration 結果
 * @param {() => object|null} deps.loadMigrationState
 * @param {{ intake: {size: Function}, research: {size: Function} }} deps.lanes
 * @param {Function} deps.runQueued   bot.js 的 runQueued（排進佇列、完成後通知）
 * @param {(message: string) => Promise<object>} deps.commitAndPush
 * @param {{ notebooklm: boolean, ytdlp: boolean }} deps.tools
 */
export function registerAdminCommands(bot, { vault, migration, loadMigrationState, lanes, runQueued, commitAndPush, tools }) {
  const underPm2 = process.env.pm_id !== undefined;

  bot.command("status", (ctx) =>
    ctx.reply(
      formatStatus({
        vault,
        uptimeSec: process.uptime(),
        underPm2,
        lanes: { intake: lanes.intake.size(), research: lanes.research.size() },
        tools,
        migrationState: loadMigrationState(),
      })
    )
  );

  // 一般收件那條佇列順便確保不會跟正在寫的筆記同時 commit
  bot.command("sync", (ctx) =>
    runQueued(ctx, lanes.intake, {
      startText: "🔄 同步 vault 到 git 中...",
      run: () => commitAndPush("手動同步 vault 異動"),
      formatDone: gitLine,
      failPrefix: "❌ 同步失敗",
    })
  );

  bot.command("logs", async (ctx) => {
    const errorsOnly = /error/i.test(ctx.message.text);
    const file = errorsOnly ? process.env.pm_err_log_path : process.env.pm_out_log_path;
    if (!file) {
      await ctx.reply("bot 不是用 pm2 執行的（例如 pnpm dev），沒有 log 檔可以看，請看執行它的終端機。");
      return;
    }
    const text = tailLines(file, LOG_LINES);
    const body = text ? text.slice(-TELEGRAM_TEXT_LIMIT) : "（log 是空的）";
    await ctx.reply(`📜 最近的${errorsOnly ? "錯誤 " : ""}log（/logs error 只看錯誤）\n\n${body}`);
  });

  bot.command("restart", async (ctx) => {
    if (!underPm2) {
      await ctx.reply("bot 不是用 pm2 執行的，重啟後不會自動回來，請在電腦上重啟。");
      return;
    }
    const busy = lanes.intake.size() + lanes.research.size();
    if (busy && !/force/i.test(ctx.message.text)) {
      await ctx.reply(`⚠️ 佇列裡還有 ${busy} 個任務，重啟會中斷它們。確定要重啟請傳 /restart force`);
      return;
    }
    await ctx.reply("♻️ 重新啟動中，幾秒後就回來（pm2 會自動把 bot 帶起來）");
    // 結束程序交給 pm2 重啟；稍等一下讓上面的訊息送出去
    setTimeout(() => process.exit(0), 1500);
  });

  bot.command("update", async (ctx) => {
    if (!underPm2) {
      await ctx.reply("bot 不是用 pm2 執行的，更新後不會自動重啟，請在電腦上 git pull 再重啟。");
      return;
    }
    const busy = lanes.intake.size() + lanes.research.size();
    if (busy && !/force/i.test(ctx.message.text)) {
      await ctx.reply(`⚠️ 佇列裡還有 ${busy} 個任務，更新後重啟會中斷它們。確定要更新請傳 /update force`);
      return;
    }
    await ctx.reply("⬇️ 從 GitHub 拉最新版中...");
    try {
      const { updated, commits, installed } = await selfUpdate();
      if (!updated) {
        await ctx.reply("✅ 已經是最新版，不用重啟");
        return;
      }
      await ctx.reply(
        [
          `✅ 更新了 ${commits.length} 個 commit${installed ? "（依賴有變，已重新安裝）" : ""}：`,
          ...commits.slice(0, 15).map((c) => `・${c}`),
          "",
          "♻️ 重新啟動中，幾秒後就回來",
        ].join("\n")
      );
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      console.error(err);
      await ctx.reply(`❌ 更新失敗（沒有重啟，bot 照舊執行）：${String(err?.message || err)}`);
    }
  });

  bot.command("migrate", async (ctx) => {
    const action = ctx.message.text.replace(/^\/migrate(@\w+)?\s*/, "").trim();
    const state = loadMigrationState();
    if (!action) {
      await ctx.reply(`🔁 舊筆記重建\n\n${formatMigrationStatus(state)}`);
      return;
    }
    if (!state) {
      await ctx.reply(formatMigrationStatus(null));
      return;
    }
    if (action === "retry") {
      // 重建可能要很久（研究要跑 deep research），排在研究那條佇列，不擋一般收件
      await runQueued(ctx, lanes.research, {
        startText: "🔁 重跑未完成的重建中（研究筆記每組可能要半小時），完成後通知你...",
        run: async () => {
          await migration.rebuild();
          const after = await migration.rebuildResearch();
          if (Object.keys(after.failed).length) return { finalized: false, state: after };
          await migration.finalize();
          await commitAndPush("舊筆記重建：重跑並收尾");
          return { finalized: true, state: loadMigrationState() };
        },
        formatDone: ({ finalized, state: s }) =>
          `${finalized ? "✅ 全部重建完成並已收尾" : "⚠️ 還有失敗的組，先不收尾"}\n\n${formatMigrationStatus(s)}`,
        failPrefix: "❌ 重建失敗",
      });
      return;
    }
    if (action === "finalize") {
      await runQueued(ctx, lanes.research, {
        startText: "🧹 收尾已完成的組（改寫連結、刪除舊筆記）...",
        run: async () => {
          const s = await migration.finalize();
          await commitAndPush("舊筆記重建：收尾已完成的組");
          return s;
        },
        formatDone: (s) => `✅ 收尾完成\n\n${formatMigrationStatus(s)}`,
        failPrefix: "❌ 收尾失敗",
      });
      return;
    }
    await ctx.reply("用法：/migrate（看進度）、/migrate retry（重跑失敗的組）、/migrate finalize（收尾已完成的組）");
  });
}
