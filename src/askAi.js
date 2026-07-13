import Anthropic from "@anthropic-ai/sdk";
import {
  CLASSIFIER_MODE,
  AGENT_CLI_COMMAND,
  AGENT_CLI_ARGS,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL,
} from "./config.js";
import { runCli, tryExtractJsonObject } from "./cliRunner.js";

// 跟 promptBuilder.js 的 CLI_SHORT_INSTRUCTION 同一套慣用法：
// 完整內容（問題 + 找到的筆記）從 stdin 餵進去，位置參數只帶一句固定短指令。
const ASK_SHORT_INSTRUCTION =
  "請根據上面由標準輸入提供的筆記內容回答問題，只回傳答案本身（可以用 Markdown 條列），不要有其他前言或結語。";

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// 呼叫本機 agent CLI 或 Anthropic API 回答一個問題（純文字問答，不是結構化分類）。
// 沿用 CLASSIFIER_MODE 決定要走哪一條路，跟分類功能用同一套授權/額度。
export async function askAi(prompt) {
  if (CLASSIFIER_MODE === "cli") {
    const raw = await runCli(AGENT_CLI_COMMAND, [...AGENT_CLI_ARGS, ASK_SHORT_INSTRUCTION], prompt, {
      timeoutMs: 90_000,
    });
    // claude / cursor-agent 的 --output-format json 會包一層 { result: "..." }，
    // 純文字模式的 CLI 則直接印答案，兩種都要能處理。
    const envelope = tryExtractJsonObject(raw);
    if (envelope && typeof envelope.result === "string" && envelope.result.trim()) {
      return envelope.result.trim();
    }
    return raw.trim();
  }

  const response = await getAnthropicClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "(沒有取得回應)";
}
