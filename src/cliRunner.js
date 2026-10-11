import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;

// 子程序不能繼承 bot 的 Telegram 設定：claude -p 啟動時會載入 Telegram plugin，plugin 優先讀環境變數
// TELEGRAM_BOT_TOKEN，拿到 bot 的 token 就會跟 bot 搶著收訊息（409 Conflict），bot 收不到後續訊息。
function childEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TELEGRAM_")));
}

// 執行本機 agent CLI，把 input 從 stdin 餵進去，回傳完整 stdout。
// aiBackends.js 的 CLI adapter 用這支，
// 避免重複實作 spawn / timeout / 錯誤處理邏輯。
export function runCli(command, args, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent CLI 逾時（超過 ${timeoutMs / 1000} 秒）`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`無法執行 "${command}"：${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // claude CLI 的錯誤（例如用量額度用完）有時印在 stdout，stderr 是空的
        const detail = stderr.trim().slice(0, 500) || stdout.trim().slice(-500) || "(無錯誤訊息)";
        reject(new Error(`agent CLI 結束代碼 ${code}：${detail}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// 從一段文字裡把 JSON 物件抓出來：先試著整段當 JSON 解析，
// 失敗的話再用「第一個 { 到最後一個 }」的方式抓，容忍前後多印了說明文字或 code fence。
// 抓不到就回傳 null（不丟例外），讓呼叫端可以繼續往下一種方式嘗試。
export function tryExtractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallthrough
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}
