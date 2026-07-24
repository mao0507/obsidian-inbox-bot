import { startServer } from "./server.js";
import { startBot } from "./bot.js";
import { startAuthKeepalive } from "./notebookResearch.js";

// 保險：任何一次分類/擷取（尤其是 Playwright 那段）萬一丟出沒被 catch 到的錯誤，
// 只印出來，不要讓整個 server／bot process 掛掉，導致下一個請求變成
// ERR_CONNECTION_REFUSED（連不上，因為 process 已經死了）。
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

startServer();
startBot();
startAuthKeepalive();
