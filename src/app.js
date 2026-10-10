// Composition root：唯一把 config.js（.env）接到各個深 module 的地方。
// 深 module 本身（noteStore、aiBackends、pipeline 等）不 import config，測試可以直接傳自己的參數建立。
import {
  VAULT_PATH,
  CLASSIFIER_MODE,
  AGENT_CLI_COMMAND,
  AGENT_CLI_ARGS,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL,
  NOTEBOOKLM_COMMAND,
  NOTEBOOKLM_LOGIN_BROWSER,
  YTDLP_COMMAND,
} from "./config.js";
import { createNoteStore } from "./noteStore.js";
import { createCliBackend, createApiBackend } from "./aiBackends.js";
import { createNotebookResearch, createNotebookLmRunner } from "./notebookResearch.js";
import { createPipeline } from "./pipeline.js";
import { createWebFetcher } from "./extractContent.js";
import { createYouTubeFetcher, createYtDlpRunner, isYouTubeUrl } from "./youtube.js";
import { commitAndPush } from "./gitSync.js";

export const vault = createNoteStore(VAULT_PATH);

// CLI 或 API 只在這裡決定一次（CLASSIFIER_MODE 的判斷邏輯見 config.js）。
export const ai =
  CLASSIFIER_MODE === "cli"
    ? createCliBackend({ command: AGENT_CLI_COMMAND, args: AGENT_CLI_ARGS })
    : createApiBackend({ apiKey: ANTHROPIC_API_KEY, model: CLAUDE_MODEL });

export const notebook = createNotebookResearch({
  run: createNotebookLmRunner(NOTEBOOKLM_COMMAND),
  ai,
  loginBrowser: NOTEBOOKLM_LOGIN_BROWSER,
});

const webFetcher = createWebFetcher();
const youtubeFetcher = createYouTubeFetcher({ run: createYtDlpRunner(YTDLP_COMMAND), web: webFetcher });

export const pipeline = createPipeline({
  vault,
  ai,
  fetcher: { fetch: (url) => (isYouTubeUrl(url) ? youtubeFetcher : webFetcher).fetch(url) },
  notebook,
  git: { commitAndPush },
});
