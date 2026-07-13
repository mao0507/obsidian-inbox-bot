import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;

// 執行本機 agent CLI，把 input 從 stdin 餵進去，回傳完整 stdout。
// classifyViaCli.js（文章分類）和 askAi.js（筆記問答）共用這支，
// 避免重複實作 spawn / timeout / 錯誤處理邏輯。
export function runCli(command, args, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
        reject(new Error(`agent CLI 結束代碼 ${code}：${stderr.slice(0, 500) || "(無錯誤訊息)"}`));
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
