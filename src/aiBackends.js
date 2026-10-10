import Anthropic from "@anthropic-ai/sdk";
import { runCli, tryExtractJsonObject } from "./cliRunner.js";

// AI backend seam：本機 agent CLI 跟 Anthropic API 兩個 adapter，interface 完全一樣：
//   ask(prompt, { instruction, maxTokens }) -> string     純文字問答
//   askJson({ system, user, tool })         -> object     結構化輸出（形狀由 tool.input_schema 決定）
// 要用哪一個只在 app.js 決定一次；呼叫端（noteDrafter、askVault、notebookResearch）不知道背後是誰。
// 這支不 import config.js，測試可以塞假的 run / client 進來。

// 從 tool.input_schema 產生給 CLI 看的 JSON 格式說明，跟 API 的 tool 定義共用同一份欄位描述。
function describeType(prop) {
  if (prop.type === "array") return `${describeType(prop.items || {})}[]`;
  if (prop.type === "object") {
    const fields = Object.entries(prop.properties || {}).map(([key, p]) => `"${key}": ${describeType(p)}`);
    return `{ ${fields.join(", ")} }`;
  }
  if (prop.enum) return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  return prop.type || "any";
}

function describeSchema(tool) {
  const fields = Object.entries(tool.input_schema.properties).map(
    ([key, prop]) => `  "${key}": ${describeType(prop)}，${prop.description || ""}`
  );
  return `{\n${fields.join(",\n")}\n}`;
}

// 精讀筆記要求完整保留原文細節，長文整理出來可能上萬字：輸出上限與 CLI 逾時都要放寬。
const JSON_MAX_TOKENS = 16_000;
const CLI_JSON_TIMEOUT_MS = 5 * 60 * 1000;

// 大部分 agent CLI（claude、cursor-agent 等）的用法都是「內容用 stdin 管進去，指令用一個簡短的位置參數帶著」，
// 例如 `git diff | agent -p "summarize this"`。完整 prompt 塞進參數在某些系統上會超過命令列長度限制。
const CLI_JSON_INSTRUCTION =
  "請完成上面由標準輸入提供的任務，只回傳一個符合規定格式的 JSON 物件，不要有其他文字。";

export function createCliBackend({ command, args, run = runCli }) {
  // 依序嘗試幾種可能的輸出形狀，取第一個「看起來真的是目標物件」的：
  // 1. claude / cursor-agent 的 --output-format json 外層包裝，實際內容在 result 欄位（字串）裡
  // 2. CLI 沒包外層、直接印出目標 JSON
  // 3. 目標 JSON 混在其他文字裡，退而求其次整段暴力擷取
  function extractTarget(raw, looksRight) {
    const envelope = tryExtractJsonObject(raw);
    if (envelope && typeof envelope.result === "string") {
      const inner = tryExtractJsonObject(envelope.result);
      if (looksRight(inner)) return inner;
    }
    if (looksRight(envelope)) return envelope;
    return null;
  }

  return {
    name: command,

    async ask(prompt, { instruction, timeoutMs = 90_000 } = {}) {
      const raw = await run(command, [...args, instruction], prompt, { timeoutMs });
      // --output-format json 會包一層 { result: "..." }，純文字模式的 CLI 則直接印答案。
      const envelope = tryExtractJsonObject(raw);
      if (envelope && typeof envelope.result === "string" && envelope.result.trim()) {
        return envelope.result.trim();
      }
      return raw.trim();
    },

    async askJson({ system, user, tool }) {
      const prompt = `${system}

${user}

輸出格式規定（非常重要）：
- 只能輸出一個 JSON 物件，不要有任何其他文字、不要用 markdown code fence 包住，不要有前言或結語。
- JSON 結構必須完全符合：
${describeSchema(tool)}
- 不要呼叫任何工具、不要讀寫檔案，直接把結果 JSON 印出來就好。`;

      const raw = await run(command, [...args, CLI_JSON_INSTRUCTION], prompt, { timeoutMs: CLI_JSON_TIMEOUT_MS });
      const keys = tool.input_schema.required || [];
      const looksRight = (obj) => !!obj && typeof obj === "object" && keys.some((k) => k in obj);
      const payload = extractTarget(raw, looksRight);
      if (!payload) {
        console.error(`[ai] CLI（${command}）原始輸出（解析失敗，完整內容如下）：\n${raw}`);
        throw new Error(`CLI（${command}）沒有回傳可用的 JSON 結果，原始輸出前 300 字：${raw.slice(0, 300)}`);
      }
      return payload;
    },
  };
}

export function createApiBackend({ apiKey, model, client = null }) {
  let anthropic = client;
  const getClient = () => (anthropic ??= new Anthropic({ apiKey }));

  return {
    name: `Anthropic API（${model}）`,

    async ask(prompt, { maxTokens = 1500 } = {}) {
      const response = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock ? textBlock.text.trim() : "(沒有取得回應)";
    },

    async askJson({ system, user, tool }) {
      const response = await getClient().messages.create({
        model,
        max_tokens: JSON_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
      });
      const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === tool.name);
      if (!toolUse) {
        throw new Error("Claude 沒有回傳預期的結構化結果，請重試一次");
      }
      return toolUse.input;
    },
  };
}
