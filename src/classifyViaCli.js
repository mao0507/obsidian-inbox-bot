import { AGENT_CLI_COMMAND, AGENT_CLI_ARGS } from "./config.js";
import { buildCliPrompt, CLI_SHORT_INSTRUCTION } from "./promptBuilder.js";
import { isValidFolder } from "./taxonomy.js";
import { runCli, tryExtractJsonObject } from "./cliRunner.js";

// 判斷解析出來的物件是不是真的長得像我們要的分類結果（而不是外層包裝本身）。
function looksLikeClassifyResult(obj) {
  return !!obj && typeof obj === "object" && "folder" in obj && "body" in obj;
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

  // 依序嘗試幾種可能的輸出形狀，取第一個「看起來真的是分類結果」的：
  // 1. claude / cursor-agent 的 --output-format json 外層包裝，實際內容在 result 欄位（字串）裡
  // 2. CLI 沒包外層、直接印出目標 JSON
  // 3. 目標 JSON 混在其他文字（例如外層包裝本身）裡，退而求其次整段暴力擷取
  let payload = null;

  const envelope = tryExtractJsonObject(raw);
  if (envelope && typeof envelope.result === "string") {
    payload = tryExtractJsonObject(envelope.result);
  }
  if (!looksLikeClassifyResult(payload) && envelope && looksLikeClassifyResult(envelope)) {
    payload = envelope;
  }
  if (!looksLikeClassifyResult(payload)) {
    payload = tryExtractJsonObject(raw);
  }

  if (!looksLikeClassifyResult(payload)) {
    console.error(`[classifier] CLI（${AGENT_CLI_COMMAND}）原始輸出（解析失敗，完整內容如下）：\n${raw}`);
    throw new Error(
      `CLI（${AGENT_CLI_COMMAND}）沒有回傳可用的分類結果，原始輸出前 300 字：${raw.slice(0, 300)}`
    );
  }

  const required = ["folder", "filename", "title", "tags", "summary", "body"];
  for (const key of required) {
    if (!(key in payload)) {
      console.error(`[classifier] CLI（${AGENT_CLI_COMMAND}）原始輸出：\n${raw}`);
      throw new Error(
        `CLI（${AGENT_CLI_COMMAND}）回傳的 JSON 缺少欄位「${key}」，解析到的物件：${JSON.stringify(payload).slice(0, 300)}`
      );
    }
  }

  if (!isValidFolder(payload.folder)) {
    console.warn(`[classifier] CLI 選了不合法的資料夾「${payload.folder}」，改放進 收件匣/待整理`);
    payload.folder = "收件匣/待整理";
  }

  return payload;
}
