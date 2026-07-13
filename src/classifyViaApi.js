import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from "./config.js";
import { VALID_FOLDERS, buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { isValidFolder } from "./taxonomy.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const FILE_NOTE_TOOL = {
  name: "file_note",
  description:
    "把整理好的內容存成一篇 Obsidian 筆記：決定分類資料夾、檔名、標籤，並產生正文。",
  input_schema: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description:
          `這篇筆記要放進哪個資料夾。多數情況必須是下面清單中已存在的路徑之一：${VALID_FOLDERS.join("、")}。` +
          `例外是動態分類「07 旅遊」：沒有固定子資料夾清單，請自己依文章描述的地區組成 "07 旅遊/國家/城市或地區"` +
          `（繁體中文，例如 "07 旅遊/日本/北海道"、"07 旅遊/台灣/台中"），地區不明確時不要用這個分類。`,
      },
      filename: {
        type: "string",
        description: "檔名（不含副檔名 .md），簡短明確，可用中文，避免 / \\ : * ? \" < > | 等符號",
      },
      title: { type: "string", description: "筆記標題" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3~6 個主題標籤，不含 # 符號、不能有空白（例如要寫 \"ClaudeCode\" 不要寫 \"Claude Code\"）",
      },
      summary: { type: "string", description: "一到兩句話摘要，會放進 frontmatter" },
      reasoning: { type: "string", description: "簡短說明為什麼分到這個資料夾" },
      body: {
        type: "string",
        description: "筆記正文，Markdown 格式（不含 frontmatter）",
      },
    },
    required: ["folder", "filename", "title", "tags", "summary", "body"],
  },
};

export async function classifyViaApi({ rawText, fetched, sourceChannel }) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(sourceChannel),
    messages: [{ role: "user", content: buildUserPrompt({ rawText, fetched }) }],
    tools: [FILE_NOTE_TOOL],
    tool_choice: { type: "tool", name: "file_note" },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "file_note");
  if (!toolUse) {
    throw new Error("Claude 沒有回傳預期的分類結果，請重試一次");
  }

  const payload = toolUse.input;
  if (!isValidFolder(payload.folder)) {
    console.warn(`[classifier] API 選了不合法的資料夾「${payload.folder}」，改放進 00 Inbox/待整理`);
    payload.folder = "00 Inbox/待整理";
  }
  return payload;
}
