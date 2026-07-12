import { spawn } from "node:child_process";
import { AGENT_CLI_COMMAND, AGENT_CLI_ARGS } from "./config.js";
import { VALID_FOLDERS, buildCliPrompt, CLI_SHORT_INSTRUCTION } from "./promptBuilder.js";

const TIMEOUT_MS = 120_000;

function runCli(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent CLI 逾時（超過 ${TIMEOUT_MS / 1000} 秒）`));
    }, TIMEOUT_MS);

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

// 從輸出裡把 JSON 物件抓出來：先試著整段當 JSON 解析，
// 失敗的話再用「第一個 { 到最後一個 }」的方式抓，容忍 CLI 多印了說明文字或 code fence。
function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallthrough
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("在 CLI 輸出裡找不到 JSON 物件");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

export async function classifyViaCli({ rawText, fetched, sourceChannel }) {
  // 完整的系統規則 + 使用者內容 + 輸出格式要求，全部從 stdin 餵給 CLI，
  // 避免內容太長（例如抓了好幾個網頁）在某些系統上超出命令列參數長度限制。
  const fullPrompt = buildCliPrompt({ rawText, fetched, sourceChannel });

  // 位置參數只放一句固定的短指令：「照 stdin 內容做完分類，只回 JSON」。
  // claude、cursor-agent（agent）等主流 agent CLI 都是「大內容用 stdin 管、
  // 短指令用參數帶」這種慣用法（例如 `git diff | agent -p "summarize"`）。
  const args = [...AGENT_CLI_ARGS, CLI_SHORT_INSTRUCTION];

  const raw = await runCli(AGENT_CLI_COMMAND, args, fullPrompt);

  let payload;
  try {
    const envelope = JSON.parse(raw.trim());
    // claude / cursor-agent 的 --output-format json 都會包成
    // { type, subtype, is_error, result, session_id, ... }，實際內容在 result 欄位裡。
    payload = typeof envelope.result === "string" ? extractJsonObject(envelope.result) : envelope;
  } catch {
    // 不是預期的 envelope 格式，就把整個輸出當成可能含 JSON 的純文字處理
    payload = extractJsonObject(raw);
  }

  const required = ["folder", "filename", "title", "tags", "summary", "body"];
  for (const key of required) {
    if (!(key in payload)) {
      throw new Error(`CLI（${AGENT_CLI_COMMAND}）回傳的 JSON 缺少欄位「${key}」`);
    }
  }

  if (!VALID_FOLDERS.includes(payload.folder)) {
    console.warn(`[classifier] CLI 選了不在清單裡的資料夾「${payload.folder}」，改放進 00 Inbox/待整理`);
    payload.folder = "00 Inbox/待整理";
  }

  return payload;
}
