// 排查用：跟 Notion 完全無關，純粹確認 Playwright 啟動的 Chromium
// 在這台電腦上能不能連上任何一個網站。
// 如果這支都連不上，代表問題是本機的防火牆/防毒/VPN/proxy 擋住了
// Chromium 的對外連線，不是程式邏輯或 Notion 頁面本身的問題。
//
// 用法：node scripts/test-playwright-network.js
import { chromium } from "playwright";

const url = process.argv[2] || "https://example.com";

console.log(`測試連線：${url}`);
console.log("啟動 Chromium...");

let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  console.log("Chromium 啟動成功，開始導覽頁面...");
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  const title = await page.title();
  console.log("✅ 成功！頁面標題：", title);
} catch (err) {
  console.log("❌ 失敗：", err.message);
  console.log("\n如果連 example.com 都連不上，代表是本機網路環境的問題，常見原因：");
  console.log("1. Windows 防火牆封鎖了新裝的 Chromium（第一次執行 Chromium 時 Windows 有時會跳出「允許存取」的提示，若不小心按了封鎖就會這樣，去 Windows 安全性 > 防火牆與網路保護 檢查看看）");
  console.log("2. 防毒軟體（Norton、McAfee、企業版 EDR 等）攔截了自動化瀏覽器的連線");
  console.log("3. 公司網路/VPN 需要額外設定 proxy 才能讓 Chromium 連上外網");
  console.log("4. DNS 設定問題導致連不到部分網域");
} finally {
  if (browser) await browser.close();
}
