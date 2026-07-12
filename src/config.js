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
