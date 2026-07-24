import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

function required(name) {
  const v = process.env[name];
  if (!v || v.includes("xxxxxxxx")) {
    console.error(`[設定錯誤] 請在 .env 檔設定 ${name}（參考 .env.example）`);
    process.exit(1);
  }
  return v;
}

export const VAULT_PATH = required("VAULT_PATH");

if (!fs.existsSync(VAULT_PATH) || !fs.statSync(VAULT_PATH).isDirectory()) {
  console.error(`[設定錯誤] VAULT_PATH 找不到這個資料夾: ${VAULT_PATH}`);
  process.exit(1);
}

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const PORT = Number(process.env.PORT || 3838);

// Telegram 白名單：只有這些 user ID 可以傳訊息給 bot、收到 bot 的回覆。
// .env 用逗號分隔多個 ID，例如 TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
// 留空 = 不限制（任何人都能用，見 bot.js 啟動時的警告）。
export const TELEGRAM_ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

// 常見 agent CLI 的預設非互動參數（不含最後的短指令，那個由 classifyViaCli.js 加）。
// 可以用 .env 的 AGENT_CLI_ARGS 完全覆蓋（用空白分隔），不管是哪種 CLI 都能自訂。
const KNOWN_CLI_PRESETS = {
  "claude": ["-p", "--output-format", "json"],
  "cursor-agent": ["-p", "--output-format", "json", "--trust", "--force"],
  "cursor": ["-p", "--output-format", "json", "--trust", "--force"],
  "agent": ["-p", "--output-format", "json", "--trust", "--force"],
};

// 沒指定 AGENT_CLI_COMMAND 時，依序自動偵測電腦上裝了哪一個，用找到的第一個。
const AUTO_DETECT_ORDER = ["claude", "cursor-agent", "agent"];

function commandExists(cmd) {
  try {
    const probe = process.platform === "win32" ? "where" : "command -v";
    execSync(`${probe} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const explicitCliCommand = process.env.AGENT_CLI_COMMAND;

function detectCliCommand() {
  if (explicitCliCommand) {
    return { command: explicitCliCommand, available: commandExists(explicitCliCommand) };
  }
  for (const candidate of AUTO_DETECT_ORDER) {
    if (commandExists(candidate)) {
      return { command: candidate, available: true };
    }
  }
  return { command: AUTO_DETECT_ORDER[0], available: false };
}

const detected = detectCliCommand();
export const AGENT_CLI_COMMAND = detected.command;
const cliAvailable = detected.available;

export const AGENT_CLI_ARGS = process.env.AGENT_CLI_ARGS
  ? process.env.AGENT_CLI_ARGS.split(" ").filter(Boolean)
  : KNOWN_CLI_PRESETS[AGENT_CLI_COMMAND] || ["-p", "--output-format", "json"];

// CLASSIFIER_MODE: auto（預設） | cli | api
// auto：依上面邏輯找得到任一 agent CLI 就用 CLI，找不到才退回 API key。
const requestedMode = (process.env.CLASSIFIER_MODE || "auto").toLowerCase();

export let CLASSIFIER_MODE;
if (requestedMode === "cli") {
  if (!cliAvailable) {
    console.error(
      `[設定錯誤] CLASSIFIER_MODE=cli，但找不到指令 "${AGENT_CLI_COMMAND}"。請確認已安裝並登入，或把 AGENT_CLI_COMMAND 改成正確的指令名稱。`
    );
    process.exit(1);
  }
  CLASSIFIER_MODE = "cli";
} else if (requestedMode === "api") {
  CLASSIFIER_MODE = "api";
} else {
  CLASSIFIER_MODE = cliAvailable ? "cli" : "api";
}

export const ANTHROPIC_API_KEY =
  CLASSIFIER_MODE === "api" ? required("ANTHROPIC_API_KEY") : process.env.ANTHROPIC_API_KEY || "";

console.log(
  CLASSIFIER_MODE === "cli"
    ? `[classifier] 使用本機 agent CLI「${AGENT_CLI_COMMAND}」做分類，不需要 API key`
    : `[classifier] 使用 Anthropic API（${CLAUDE_MODEL}）做分類`
);

export function vaultFilePath(...segments) {
  return path.join(VAULT_PATH, ...segments);
}

// Git 自動同步：設定 VAULT_GIT_REMOTE 後，每次新增/搬移筆記都會自動
// commit + push 到這個 remote。沒設定就完全不啟用，行為跟以前一樣。
export const VAULT_GIT_REMOTE = process.env.VAULT_GIT_REMOTE || "";
export const VAULT_GIT_BRANCH = process.env.VAULT_GIT_BRANCH || "main";
export const VAULT_GIT_ENABLED = Boolean(VAULT_GIT_REMOTE);

console.log(
  VAULT_GIT_ENABLED
    ? `[git-sync] 已啟用，筆記異動會自動同步到 ${VAULT_GIT_REMOTE}（分支 ${VAULT_GIT_BRANCH}）`
    : "[git-sync] 沒有設定 VAULT_GIT_REMOTE，筆記只會寫入本機 vault，不會同步到 git"
);

// NotebookLM 研究功能（/notebook 指令，選用）：需要另外裝 notebooklm-py CLI 並登入過
// （npm install 不會裝這個，是獨立的 Python 套件，見 README「用 NotebookLM 做深度研究」）。
// 這裡只偵測指令存不存在，不強制要求，找不到的話 /notebook 指令會回覆說明、不影響其他功能。
export const NOTEBOOKLM_COMMAND = process.env.NOTEBOOKLM_COMMAND || "notebooklm";
export const NOTEBOOKLM_ENABLED = commandExists(NOTEBOOKLM_COMMAND);

// fast（預設）：幾十秒內完成，來源較少；deep：更完整但可能要好幾分鐘到半小時。
const requestedResearchMode = (process.env.NOTEBOOKLM_RESEARCH_MODE || "fast").toLowerCase();
export const NOTEBOOKLM_RESEARCH_MODE = requestedResearchMode === "deep" ? "deep" : "fast";

// 登入 session 真的過期時，除了 `auth refresh`（只能延長「快過期」的 session），
// notebooklm-py 還支援 `auth refresh --browser-cookies <browser>`：直接重新讀取
// 這台電腦上這個瀏覽器目前的登入 cookie 來修復帳號路由，不用開一個新的互動登入視窗。
// 前提是這個瀏覽器裡本來就要有一個還有效的 Google 登入 session（例如你平常都用
// Chrome 開 Gmail/NotebookLM），才有東西可以重用——瀏覽器本身也登出的話這招沒用，
// 還是得手動 `notebooklm login`。留空則不會嘗試這個 fallback。
export const NOTEBOOKLM_LOGIN_BROWSER = process.env.NOTEBOOKLM_LOGIN_BROWSER || "chrome";

console.log(
  NOTEBOOKLM_ENABLED
    ? `[notebooklm] 已偵測到「${NOTEBOOKLM_COMMAND}」指令，/notebook 研究功能可以使用（research mode: ${NOTEBOOKLM_RESEARCH_MODE}）`
    : `[notebooklm] 找不到「${NOTEBOOKLM_COMMAND}」指令，/notebook 功能會停用（安裝步驟見 README）`
);

