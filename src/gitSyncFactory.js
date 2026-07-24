import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * 建立一組「把某個資料夾自動 commit + push 到某個 git remote」的邏輯。
 * 目前只有 gitSync.js（Obsidian vault 筆記）在用，抽成獨立 factory
 * 是為了讓初始化/commit/push/錯誤處理邏輯跟呼叫端分開，方便日後有其他資料夾
 * 也要同步到 git 時直接重複使用，不用重寫一份。
 *
 * @param {object} opts
 * @param {string} opts.repoPath 要同步的本機資料夾絕對路徑
 * @param {string} opts.remoteUrl git remote 網址，空字串代表不啟用
 * @param {string} [opts.branch] 要推到哪個分支，預設 main
 * @param {string} opts.label 印訊息時用的前綴（例如 "git-sync"）
 * @param {string} [opts.defaultGitignore] 第一次 init 時，資料夾裡沒有 .gitignore 的話要建立的預設內容
 */
// index.lock 過期判定的門檻：我們自己的每個 git 指令都有 30 秒 timeout（見 runGit），
// 所以如果鎖檔案存在超過這個時間還沒消失，幾乎可以確定不是「我們自己正在執行中的指令」
// 留下的，而是某個 git process 異常中斷（crash、被強制關閉）留下的殘留鎖檔，可以安全清除。
const STALE_LOCK_THRESHOLD_MS = 45_000;

export function createGitSync({ repoPath, remoteUrl, branch = "main", label, defaultGitignore }) {
  const enabled = Boolean(remoteUrl);
  let ensured = false;

  // 同一個資料夾的 git 操作全部序列化：這支程式可能同時處理好幾個來源
  // （網頁表單、Telegram 一般訊息、/notebook 研究）都會各自呼叫 commitAndPush，
  // 如果真的同時執行，兩個 `git add`/`git commit` 互相搶同一個 .git/index 會直接撞出
  // 「Another git process seems to be running」——用一個 Promise 鏈把所有呼叫排成
  // 一個接一個執行，就不會有「自己跟自己搶」這個問題（外部程式仍可能造成鎖檔，
  // 這種情況由下面的過期鎖自動清除機制處理）。
  let queue = Promise.resolve();
  function serialized(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  function runGit(args) {
    return execFileAsync("git", args, {
      cwd: repoPath,
      // 非互動模式：如果 git 需要帳密/token 才能 push，直接失敗回傳錯誤，
      // 不要卡住等使用者輸入（這支程式是背景執行，沒有人可以互動輸入）。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  // 確保資料夾存在、是個 git repo、有設定好 remote origin。
  // 只在第一次真正要同步時做初始化，成功一次後就不會重複做。
  // 任何一步失敗都只印警告、回傳 false，不會丟出例外——呼叫端的主要工作
  // （寫筆記）已經完成，git 同步只是附加功能，失敗不該讓主要工作被當成失敗。
  async function ensureRepoReady() {
    if (ensured) return true;
    if (!enabled) return false;

    try {
      fs.mkdirSync(repoPath, { recursive: true });

      const gitDir = path.join(repoPath, ".git");
      if (!fs.existsSync(gitDir)) {
        console.log(`[${label}] 資料夾還不是 git repo，執行 git init...`);
        await runGit(["init"]);
        await runGit(["checkout", "-B", branch]);

        if (defaultGitignore) {
          const gitignorePath = path.join(repoPath, ".gitignore");
          if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, defaultGitignore, "utf8");
            console.log(`[${label}] 已建立預設 .gitignore`);
          }
        }
      }

      const { stdout: remotes } = await runGit(["remote"]);
      if (!remotes.split("\n").map((s) => s.trim()).includes("origin")) {
        console.log(`[${label}] 設定 remote origin -> ${remoteUrl}`);
        await runGit(["remote", "add", "origin", remoteUrl]);
      }

      ensured = true;
      return true;
    } catch (err) {
      console.error(`[${label}] 初始化 git repo 失敗：${err.message}`);
      return false;
    }
  }

  // 判斷是不是「index.lock 已存在」這種錯誤（訊息裡通常會提到 index.lock 或
  // "Another git process seems to be running"）。
  function isLockError(detail) {
    return /index\.lock/i.test(detail) || /another git process/i.test(detail);
  }

  // 檢查 .git/index.lock 是否存在且已經過期（超過 STALE_LOCK_THRESHOLD_MS 沒被清掉），
  // 是的話刪掉並回傳 true；不存在、還很新（可能真的有其他 process 在跑）、
  // 或刪除失敗都回傳 false，呼叫端就不會重試，直接把原始錯誤回報出去。
  function clearStaleLockIfAny() {
    const lockPath = path.join(repoPath, ".git", "index.lock");
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < STALE_LOCK_THRESHOLD_MS) {
        return false;
      }
      fs.unlinkSync(lockPath);
      console.warn(`[${label}] 清除過期的 .git/index.lock（存在 ${Math.round(ageMs / 1000)} 秒，判定是殘留鎖檔）`);
      return true;
    } catch {
      return false;
    }
  }

  async function commitAndPushOnce(message) {
    await runGit(["add", "-A"]);

    const { stdout: statusOut } = await runGit(["status", "--porcelain"]);
    if (!statusOut.trim()) {
      return { attempted: true, pushed: false, skipped: true };
    }

    await runGit(["commit", "-m", message]);

    // push 前先試著拉一下遠端（例如你在其他裝置上也有同步這個資料夾），
    // 避免單純 push 因為落後遠端而被拒絕。第一次 push、還沒有上游分支等情況
    // 這一步會失敗，直接忽略即可，不當成錯誤處理。
    try {
      await runGit(["pull", "--rebase", "--autostash", "origin", branch]);
    } catch {
      // ignore
    }

    await runGit(["push", "-u", "origin", branch]);
    console.log(`[${label}] 已推上 git：${message}`);
    return { attempted: true, pushed: true };
  }

  /**
   * 把資料夾目前所有異動 commit 並 push 到 remote。
   * 沒有設定 remoteUrl 時直接跳過（回傳 attempted:false）。
   * 任何一步失敗都不會丟出例外，回傳結果讓呼叫端自己決定要不要顯示同步失敗訊息。
   * 同一個資料夾的呼叫會自動排隊序列化，不會互相搶 .git/index。
   */
  function commitAndPush(message) {
    return serialized(async () => {
      if (!enabled) {
        return { attempted: false };
      }

      const ready = await ensureRepoReady();
      if (!ready) {
        return { attempted: true, pushed: false, error: "git repo 初始化失敗" };
      }

      try {
        return await commitAndPushOnce(message);
      } catch (err) {
        const detail = err.stderr ? String(err.stderr).trim() : err.message;

        // 過期的 index.lock（通常是之前某個 git process 被強制中斷留下的殘留檔）
        // 自動清除後重試一次；不是這種情況、或清除失敗，就照原本邏輯回報錯誤。
        if (isLockError(detail) && clearStaleLockIfAny()) {
          try {
            return await commitAndPushOnce(message);
          } catch (retryErr) {
            const retryDetail = retryErr.stderr ? String(retryErr.stderr).trim() : retryErr.message;
            console.error(`[${label}] 清除過期鎖檔後重試仍失敗：${retryDetail}`);
            return { attempted: true, pushed: false, error: retryDetail };
          }
        }

        console.error(`[${label}] 推上 git 失敗：${detail}`);
        return { attempted: true, pushed: false, error: detail };
      }
    });
  }

  return { commitAndPush, enabled };
}
