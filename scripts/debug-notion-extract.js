// 排查用：完整跑一次 fetchNotionViaPlaywright 實際會做的事（domcontentloaded → 輪詢文字量），
// 但每一輪都印出目前抓到的文字長度，用來看是「文字真的很少」還是「還在長、但被提早判定穩定」。
//
// 用法：node scripts/debug-notion-extract.js <網址>
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.error("用法: node scripts/debug-notion-extract.js <網址>");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const page = await browser.newPage();

console.log("導覽中...");
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
console.log("domcontentloaded 完成，開始輪詢文字量：\n");

const maxWaitMs = 20000; // 拉長一點，看看到底最後會長到多少
const pollMs = 500;
const start = Date.now();
let lastLength = -1;

while (Date.now() - start < maxWaitMs) {
  const len = await page.evaluate(() => (document.body.innerText || "").length);
  console.log(`[+${Date.now() - start}ms] 目前文字長度：${len}`);
  lastLength = len;
  await page.waitForTimeout(pollMs);
}

const finalText = await page.evaluate(() => document.body.innerText || "");
console.log("\n最終文字長度：", finalText.length);
console.log("\n--- 內文前 800 字 ---\n");
console.log(finalText.slice(0, 800));

await browser.close();
