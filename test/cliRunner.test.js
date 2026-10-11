import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cliRunner.js";

// claude -p 會載入 Telegram plugin，plugin 優先讀環境變數 TELEGRAM_BOT_TOKEN；
// 子程序若繼承到 bot 的 token，就會跟 bot 搶同一個 token 收訊息（409 Conflict）。
test("agent CLI child process does not inherit the bot's Telegram secrets", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:secret";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  try {
    const out = await runCli(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({t:process.env.TELEGRAM_BOT_TOKEN??null,u:process.env.TELEGRAM_ALLOWED_USER_IDS??null,p:!!process.env.PATH})))"],
      ""
    );
    assert.deepEqual(JSON.parse(out), { t: null, u: null, p: true });
  } finally {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
  }
});
