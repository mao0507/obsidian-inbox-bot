import { Markup } from "telegraf";
import { findDuplicateCards, mergeCards } from "./cardMerge.js";
import { tagUsage, mergeTags, findSimilarTags } from "./tagMerge.js";

// vault 整理類 Telegram 指令：/cards（合併重複概念卡）、/tags（看 tag 使用量、找相似 tag、合併 tag）。
// 會改動 vault 的動作都排進一般收件那條佇列，避免跟正在寫入的筆記同時改檔案或 commit。

const pendingCardGroups = new Map(); // 訊息 id -> { keep, merge }
const pendingTagGroups = new Map(); // 訊息 id -> { keep, merge }

// AI 找到的每一組各發一則訊息、附「合併／略過」按鈕；pending 記住訊息對應的分組
async function offerGroups(ctx, groups, pending, { prefix, describe }) {
  for (const group of groups) {
    const msg = await ctx.reply(describe(group));
    pending.set(msg.message_id, group);
    await ctx.telegram.editMessageReplyMarkup(ctx.chat.id, msg.message_id, undefined, {
      inline_keyboard: [
        [
          Markup.button.callback("✅ 合併", `${prefix}m|${msg.message_id}`),
          Markup.button.callback("略過", `${prefix}s|${msg.message_id}`),
        ],
      ],
    });
  }
}

/**
 * @param {import("telegraf").Telegraf} bot
 * @param {{ vault, ai, intakeLane, runQueued: Function, inBackground: Function, editStatus: Function,
 *           commitAndPush: (message: string) => Promise<object> }} deps
 */
export function registerVaultToolCommands(bot, { vault, ai, intakeLane, runQueued, inBackground, editStatus, commitAndPush }) {
  bot.command("cards", async (ctx) => {
    const status = await ctx.reply("🔍 請 AI 找重複的概念卡中（大約 1 分鐘）...");
    inBackground(async () => {
      try {
        const groups = await findDuplicateCards(vault, ai);
        if (!groups.length) {
          await editStatus(ctx, status, "✅ 沒有找到重複的概念卡");
          return;
        }
        await editStatus(ctx, status, `🔍 找到 ${groups.length} 組可能重複的概念卡，每組各自確認：`);
        await offerGroups(ctx, groups, pendingCardGroups, {
          prefix: "c",
          describe: (g) => `合併到「${g.keep}」：\n${g.merge.map((n) => `・${n}`).join("\n")}\n\n理由：${g.reason}`,
        });
      } catch (err) {
        console.error(err);
        await editStatus(ctx, status, `❌ 找重複卡片失敗：${String(err?.message || err)}`);
      }
    });
  });

  bot.action(/^(cm|cs)\|(\d+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const msg = { message_id: Number(id) };
    const group = pendingCardGroups.get(msg.message_id);
    await ctx.answerCbQuery().catch(() => {});
    if (!group) {
      await editStatus(ctx, msg, "這組已經處理過或已過期，請重新 /cards");
      return;
    }
    pendingCardGroups.delete(msg.message_id);
    const label = `「${group.merge.join("、")}」→「${group.keep}」`;
    if (action === "cs") {
      await editStatus(ctx, msg, `略過 ${label}`);
      return;
    }
    await editStatus(ctx, msg, `⏳ 合併中 ${label}`);
    await runQueued(ctx, intakeLane, {
      startText: `🃏 合併概念卡 ${label}...`,
      run: async () => {
        const result = mergeCards(vault, group.keep, group.merge);
        await commitAndPush(`合併概念卡：${group.merge.join("、")} → ${group.keep}`);
        return result;
      },
      formatDone: ({ merged, notesUpdated }) => `✅ 已合併 ${merged} 張卡片到「${group.keep}」，更新了 ${notesUpdated} 篇筆記的連結`,
      failPrefix: "❌ 合併概念卡失敗",
    });
  });

  bot.command("tags", async (ctx) => {
    const args = ctx.message.text.replace(/^\/tags(@\w+)?\s*/, "").trim().split(/\s+/).filter(Boolean);

    if (args[0] === "similar") {
      const status = await ctx.reply("🔍 請 AI 找寫法不同的同一個 tag 中（大約 1 分鐘）...");
      inBackground(async () => {
        try {
          const groups = await findSimilarTags(vault, ai);
          if (!groups.length) {
            await editStatus(ctx, status, "✅ 沒有找到相似的 tag");
            return;
          }
          await editStatus(ctx, status, `🔍 找到 ${groups.length} 組可能重複的 tag，每組各自確認：`);
          await offerGroups(ctx, groups, pendingTagGroups, {
            prefix: "t",
            describe: (g) => `併進 #${g.keep}：${g.merge.map((t) => `#${t}`).join(" ")}\n\n理由：${g.reason}`,
          });
        } catch (err) {
          console.error(err);
          await editStatus(ctx, status, `❌ 找相似 tag 失敗：${String(err?.message || err)}`);
        }
      });
      return;
    }

    if (args[0] === "merge") {
      const [, from, into] = args;
      if (!from || !into) {
        await ctx.reply("用法：/tags merge 要併掉的tag 保留的tag\n例如：/tags merge Vuejs Vue");
        return;
      }
      await runQueued(ctx, intakeLane, {
        startText: `🏷️ 把 #${from} 併進 #${into} 中...`,
        run: async () => {
          const result = mergeTags(vault, from, into);
          await commitAndPush(`合併 tag：${from} → ${into}`);
          return result;
        },
        formatDone: ({ retagged, moved }) =>
          `✅ 已把 #${from} 併進 #${into}：改了 ${retagged} 篇筆記的 tag、搬了 ${moved} 篇筆記的資料夾。之後寫 ${from} 也會自動變成 ${into}。`,
        failPrefix: "❌ 合併 tag 失敗",
      });
      return;
    }

    const usage = tagUsage(vault);
    const top = usage.slice(0, 30).map(([tag, n]) => `#${tag}（${n}）`).join(" ");
    const singles = usage.filter(([, n]) => n === 1).map(([tag]) => `#${tag}`);
    await ctx.reply(
      [
        `🏷️ 共 ${usage.length} 個 tag`,
        "",
        `最常用：${top}`,
        "",
        `只用在 1 篇的 tag（${singles.length} 個，常是別的 tag 的另一種寫法）：`,
        singles.join(" ").slice(0, 3000) || "（沒有）",
        "",
        "合併：/tags merge 要併掉的tag 保留的tag（例如 /tags merge Vuejs Vue）",
        "讓 AI 找寫法不同的同一個 tag：/tags similar",
      ].join("\n")
    );
  });

  bot.action(/^(tm|ts)\|(\d+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const msg = { message_id: Number(id) };
    const group = pendingTagGroups.get(msg.message_id);
    await ctx.answerCbQuery().catch(() => {});
    if (!group) {
      await editStatus(ctx, msg, "這組已經處理過或已過期，請重新 /tags similar");
      return;
    }
    pendingTagGroups.delete(msg.message_id);
    const label = `${group.merge.map((t) => `#${t}`).join(" ")} → #${group.keep}`;
    if (action === "ts") {
      await editStatus(ctx, msg, `略過 ${label}`);
      return;
    }
    await editStatus(ctx, msg, `⏳ 合併中 ${label}`);
    await runQueued(ctx, intakeLane, {
      startText: `🏷️ 合併 tag ${label}...`,
      run: async () => {
        const total = { retagged: 0, moved: 0 };
        for (const from of group.merge) {
          const { retagged, moved } = mergeTags(vault, from, group.keep);
          total.retagged += retagged;
          total.moved += moved;
        }
        await commitAndPush(`合併 tag：${group.merge.join("、")} → ${group.keep}`);
        return total;
      },
      formatDone: ({ retagged, moved }) => `✅ 已合併 ${label}：改了 ${retagged} 篇筆記的 tag、搬了 ${moved} 篇筆記的資料夾`,
      failPrefix: "❌ 合併 tag 失敗",
    });
  });
}
