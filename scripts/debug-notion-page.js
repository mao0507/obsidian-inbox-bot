// 排查用：對單一頁面做更詳細的診斷（記錄每個回應、有沒有被重新導向、拉長逾時），
// 用來分辨「只是比較慢」還是「真的卡住/被導去別的地方」。
//
// 用法：node scripts/debug-notion-page.js <網址> [逾時毫秒，預設 90000]
import { chromium } from "playwright";

const url = process.argv[2];
const timeout = Number(process.argv[3] || 90000);
if (!url) {
  console.error("用法: node scripts/debug-notion-page.js <網址> [逾時毫秒]");
  process.exit(1);
}

console.log(`目標網址：${url}`);
console.log(`逾時設定：${timeout}ms\n`);

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();

page.on("response", (res) => {
  console.log(`[response] ${res.status()} ${res.url()}`);
});
page.on("requestfailed", (req) => {
  console.log(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`);
});
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) {
    console.log(`[navigated] ${frame.url()}`);
  }
});

const start = Date.now();
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  console.log(`\n✅ 成功，耗時 ${Date.now() - start}ms`);
  console.log("最後停留的網址：", page.url());
  console.log("標題：", await page.title());
} catch (err) {
  console.log(`\n❌ 失敗，耗時 ${Date.now() - start}ms`);
  console.log("錯誤：", err.message);
  console.log("卡住當下的網址：", page.url());
} finally {
  await browser.close();
}
