// Composition root：唯一把 config.js（.env）接到各個深 module 的地方。
// 深 module 本身（noteStore、aiBackends、noteDrafter 等）不 import config，測試可以直接傳自己的參數建立。
import {
  VAULT_PATH,
  CLASSIFIER_MODE,
  AGENT_CLI_COMMAND,
  AGENT_CLI_ARGS,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL,
  NOTEBOOKLM_COMMAND,
  NOTEBOOKLM_RESEARCH_MODE,
  NOTEBOOKLM_LOGIN_BROWSER,
} from "./config.js";
import { createNoteStore } from "./noteStore.js";
import { createCliBackend, createApiBackend } from "./aiBackends.js";
import { createNoteDrafter } from "./noteDrafter.js";
import { createNotebookResearch, createNotebookLmRunner } from "./notebookResearch.js";
// promptBuilder -> vaultScan -> app.js 是循環 import；vaultScan 只在函式被呼叫時才讀 vault，所以安全。
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";

export const vault = createNoteStore(VAULT_PATH);

// CLI 或 API 只在這裡決定一次（CLASSIFIER_MODE 的判斷邏輯見 config.js）。
export const ai =
  CLASSIFIER_MODE === "cli"
    ? createCliBackend({ command: AGENT_CLI_COMMAND, args: AGENT_CLI_ARGS })
    : createApiBackend({ apiKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL });

export const drafter = createNoteDrafter({
  backend: ai,
  buildPrompts: (input) => ({ system: buildSystemPrompt(input.sourceChannel), user: buildUserPrompt(input) }),
});

export const notebook = createNotebookResearch({
  run: createNotebookLmRunner(NOTEBOOKLM_COMMAND),
  ai,
  researchMode: NOTEBOOKLM_RESEARCH_MODE,
  loginBrowser: NOTEBOOKLM_LOGIN_BROWSER,
});
