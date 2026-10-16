import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// /update：在跑 bot 的電腦上把專案更新到 GitHub 上的最新版（git pull --ff-only），
// 依賴有變才 pnpm install，之後由呼叫端結束程序讓 pm2 重啟。
// 只做快轉：本機有自己的 commit 或衝突時直接失敗、不動任何檔案，回報給使用者到電腦上處理。

export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPENDENCY_FILES = ["package.json", "pnpm-lock.yaml"];
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/** 預設的指令執行器：回傳 stdout；失敗時錯誤訊息帶 stderr。 */
export function runCommand(command, args, { cwd = PROJECT_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    // Windows 上 pnpm 是 .cmd，要透過 shell 才找得到；參數都是寫死的，沒有使用者輸入
    execFile(command, args, { cwd, timeout: COMMAND_TIMEOUT_MS, shell: process.platform === "win32" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args.join(" ")} 失敗：${(stderr || stdout || err.message).trim().slice(-800)}`));
      else resolve(stdout);
    });
  });
}

/**
 * @param {{ run?: typeof runCommand }} [deps]
 * @returns {Promise<{ updated: boolean, commits: string[], installed: boolean }>}
 */
export async function selfUpdate({ run = runCommand } = {}) {
  const before = (await run("git", ["rev-parse", "HEAD"])).trim();
  await run("git", ["pull", "--ff-only"]);
  const after = (await run("git", ["rev-parse", "HEAD"])).trim();
  if (before === after) return { updated: false, commits: [], installed: false };

  const commits = (await run("git", ["log", "--oneline", `${before}..${after}`])).trim().split("\n").filter(Boolean);
  const changed = (await run("git", ["diff", "--name-only", before, after])).split("\n").map((f) => f.trim());
  const installed = changed.some((f) => DEPENDENCY_FILES.includes(f));
  if (installed) await run("pnpm", ["install", "--frozen-lockfile"]);
  return { updated: true, commits, installed };
}
