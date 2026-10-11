// 舊筆記重建（一般筆記與 NotebookLM 研究筆記）。流程與安全網見 src/migration.js。
//
// 用法：
//   pnpm run migrate plan          dry-run：寫出 _系統/migration-plan.md，不改任何筆記
//   pnpm run migrate trial [N]     先重建 N 組（預設 3）讓你檢查品質；舊筆記保留
//   pnpm run migrate run           重建剩下的全部 → 改寫連結 → 刪除舊筆記 → 重新產生分類地圖
//   pnpm run migrate research-plan       研究筆記：AI 依主題分組並寫出 _系統/migration-research-plan.md
//   pnpm run migrate research-trial [N]  先重建 N 組研究（預設 1；每組 deep research 可能要半小時）
//   pnpm run migrate research-run        重建剩下的研究 → 改寫連結 → 刪除舊研究筆記
//   pnpm run migrate finalize            只收尾已完成的組（有組失敗、想先處理其他的時候用），失敗組的舊筆記保留
//
// trial / run 第一次執行前，會先把 vault 目前狀態 commit 並打上 git tag「before-migration」，
// 想反悔：在 vault 資料夾執行 git reset --hard before-migration。
// 執行期間建議先停掉背景服務（pnpm run service:uninstall），避免同時有新筆記寫入。
import { execFileSync } from "node:child_process";
import { VAULT_PATH } from "../src/config.js";
import { vault, pipeline, fetcher } from "../src/app.js";
import { commitAndPush } from "../src/gitSync.js";
import { createMigration } from "../src/migration.js";

const BACKUP_TAG = "before-migration";
const [command, arg] = process.argv.slice(2);
const migration = createMigration({ vault, pipeline, fetcher });
const git = (...args) => execFileSync("git", args, { cwd: VAULT_PATH, encoding: "utf8", stdio: "pipe" }).trim();

// vault 是 git repo 才繼續：先 commit 目前狀態，再打 tag（tag 已存在就不動，保留最早的那個快照）。
function ensureBackup() {
  try {
    git("rev-parse", "--is-inside-work-tree");
  } catch {
    console.error(`❌ ${VAULT_PATH} 不是 git repo，沒有回退的安全網。請先設定 VAULT_GIT_REMOTE（見 README）或自行備份 vault。`);
    process.exit(1);
  }
  if (git("tag", "--list", BACKUP_TAG)) {
    console.log(`ℹ️  已有 git tag「${BACKUP_TAG}」，沿用這個快照`);
    return;
  }
  git("add", "-A");
  if (git("status", "--porcelain")) git("commit", "-m", "舊筆記重建前快照");
  git("tag", BACKUP_TAG);
  console.log(`✅ 已打 git tag「${BACKUP_TAG}」（反悔：在 vault 資料夾執行 git reset --hard ${BACKUP_TAG}）`);
}

const onProgress = (msg) => console.log(msg);

switch (command) {
  case "plan": {
    const groups = await migration.plan();
    console.log(`✅ 共 ${groups.length} 組，計畫寫在 ${VAULT_PATH}/_系統/migration-plan.md`);
    break;
  }
  case "trial": {
    ensureBackup();
    const limit = Number(arg) || 3;
    await migration.rebuild({ limit, onProgress });
    await commitAndPush(`舊筆記重建試跑（${limit} 組）`);
    console.log(`✅ 試跑完成，結果見 ${VAULT_PATH}/_系統/migration-report.md；舊筆記還保留著。滿意的話執行 pnpm run migrate run`);
    break;
  }
  case "run": {
    ensureBackup();
    const state = await migration.rebuild({ onProgress });
    const failed = Object.keys(state.failed);
    if (failed.length) {
      console.error(`⚠️  有 ${failed.length} 組重建失敗（見 migration-report.md），先不刪除舊筆記。修正後重跑 pnpm run migrate run`);
      process.exit(1);
    }
    await migration.finalize();
    await commitAndPush("舊筆記重建完成");
    console.log(`✅ 重建完成：連結已改寫、舊筆記已刪除，結果見 ${VAULT_PATH}/_系統/migration-report.md`);
    break;
  }
  case "research-plan": {
    const groups = await migration.planResearch();
    console.log(`✅ ${groups.length} 組研究，計畫寫在 ${VAULT_PATH}/_系統/migration-research-plan.md`);
    break;
  }
  case "research-trial": {
    ensureBackup();
    const limit = Number(arg) || 1;
    await migration.rebuildResearch({ limit, onProgress });
    await commitAndPush(`研究筆記重建試跑（${limit} 組）`);
    console.log(`✅ 試跑完成，結果見 ${VAULT_PATH}/_系統/migration-report.md；舊筆記還保留著。滿意的話執行 pnpm run migrate research-run`);
    break;
  }
  case "research-run": {
    ensureBackup();
    const state = await migration.rebuildResearch({ onProgress });
    if (Object.keys(state.failed).length) {
      console.error("⚠️  有研究重建失敗（見 migration-report.md），先不刪除舊筆記。修正後重跑 pnpm run migrate research-run");
      process.exit(1);
    }
    await migration.finalize();
    await commitAndPush("研究筆記重建完成");
    console.log(`✅ 研究筆記重建完成，結果見 ${VAULT_PATH}/_系統/migration-report.md`);
    break;
  }
  case "finalize": {
    // 部分組失敗（例如 NotebookLM 額度用完）時，先把已完成的組收尾；失敗組的舊筆記保留，之後重跑 run / research-run
    ensureBackup();
    const state = await migration.finalize();
    await commitAndPush("舊筆記重建：收尾已完成的組");
    const failed = Object.keys(state.failed);
    console.log(`✅ 已收尾 ${Object.keys(state.done).length} 組${failed.length ? `；${failed.length} 組未完成，舊筆記保留：${failed.join("、")}` : ""}`);
    break;
  }
  default:
    console.log("用法：pnpm run migrate plan | trial [N] | run | research-plan | research-trial [N] | research-run | finalize");
    process.exit(command ? 1 : 0);
}
process.exit(0);
