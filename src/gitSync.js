import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { VAULT_PATH, VAULT_GIT_ENABLED, VAULT_GIT_REMOTE, VAULT_GIT_BRANCH } from "./config.js";

const execFileAsync = promisify(execFile);

const DEFAULT_GITIGNORE = `# Obsidian 本機狀態檔，跟裝置有關，不用同步
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.trash/

# 系統雜項檔案
.DS_Store
Thumbs.db
`;

function runGit(args) {
  return execFileAsync("git", args, {
    cwd: VAULT_PATH,
    // 非互動模式：如果 git 需要帳密/token 才能 push，直接失敗回傳錯誤，
    // 不要卡住等使用者輸入（這支程式是背景執行，沒有人可以互動輸入）。
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

let ensured = false;

// 確保 vault 資料夾是個 git repo、有設定好 remote origin。
// 只在程式啟動後第一次真正要同步時做初始化，成功一次後就不會重複做。
// 任何一步失敗都只印警告、回傳 false，不會丟出例外——筆記已經正常寫進本機 vault，
// git 同步只是附加功能，失敗不該影響主要功能。
async function ensureRepoReady() {
  if (ensured) return true;
  if (!VAULT_GIT_ENABLED) return false;

  const gitDir = path.join(VAULT_PATH, ".git");

  try {
    if (!fs.existsSync(gitDir)) {
      console.log("[git-sync] vault 資料夾還不是 git repo，執行 git init...");
      await runGit(["init"]);
      await runGit(["checkout", "-B", VAULT_GIT_BRANCH]);

      const gitignorePath = path.join(VAULT_PATH, ".gitignore");
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE, "utf8");
        console.log("[git-sync] 已建立預設 .gitignore（忽略 Obsidian 本機狀態檔）");
      }
    }

    const { stdout: remotes } = await runGit(["remote"]);
    if (!remotes.split("\n").map((s) => s.trim()).includes("origin")) {
      console.log(`[git-sync] 設定 remote origin -> ${VAULT_GIT_REMOTE}`);
      await runGit(["remote", "add", "origin", VAULT_GIT_REMOTE]);
    }

    ensured = true;
    return true;
  } catch (err) {
    console.error(
      `[git-sync] 初始化 git repo 失敗，筆記仍會正常寫入本機，只是不會同步到 git：${err.message}`
    );
    return false;
  }
}

/**
 * 把 vault 目前所有異動（新增、修改、搬移、刪除）commit 並 push 到 remote。
 * 沒有設定 VAULT_GIT_REMOTE 時直接跳過（回傳 attempted:false），不影響任何行為。
 * 任何一步失敗都不會丟出例外，回傳結果讓呼叫端自己決定要不要顯示同步失敗訊息。
 */
export async function commitAndPush(message) {
  if (!VAULT_GIT_ENABLED) {
    return { attempted: false };
  }

  const ready = await ensureRepoReady();
  if (!ready) {
    return { attempted: true, pushed: false, error: "git repo 初始化失敗" };
  }

  try {
    await runGit(["add", "-A"]);

    const { stdout: statusOut } = await runGit(["status", "--porcelain"]);
    if (!statusOut.trim()) {
      return { attempted: true, pushed: false, skipped: true };
    }

    await runGit(["commit", "-m", message]);

    // push 前先試著拉一下遠端（例如你在其他裝置上也有同步這個 vault），
    // 避免單純 push 因為落後遠端而被拒絕。第一次 push、還沒有上游分支等情況
    // 這一步會失敗，直接忽略即可，不當成錯誤處理。
    try {
      await runGit(["pull", "--rebase", "--autostash", "origin", VAULT_GIT_BRANCH]);
    } catch {
      // ignore
    }

    await runGit(["push", "-u", "origin", VAULT_GIT_BRANCH]);
    console.log(`[git-sync] 已推上 git：${message}`);
    return { attempted: true, pushed: true };
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    console.error(`[git-sync] 推上 git 失敗（筆記已經正常寫入本機 vault，只是還沒同步到 git）：${detail}`);
    return { attempted: true, pushed: false, error: detail };
  }
}
