// 單獨測試 Notion 頁面擷取，不會呼叫 AI、不會寫進 vault，只是確認 Playwright 抓不抓得到內容。
//
// 用法：
//   npx playwright install chromium   # 第一次用要先跑這行（如果還沒跑過）
//   node scripts/test-notion.js https://你的-notion-頁面網址
import { fetchUrlContent } from "../src/extractContent.js";

const url = process.argv[2];
if (!url) {
  console.error("用法: node scripts/test-notion.js <notion 頁面網址>");
  process.exit(1);
}

console.log(`正在讀取：${url}\n（第一次執行會比較慢，Playwright 要先啟動瀏覽器）\n`);

const result = await fetchUrlContent(url);

if (result.ok) {
  console.log("✅ 成功抓到內容");
  console.log("標題：", result.title);
  console.log("內文字數：", result.text.length);
  console.log("\n--- 內文前 500 字預覽 ---\n");
  console.log(result.text.slice(0, 500));
} else {
  console.log("❌ 抓取失敗");
  console.log("原因：", result.error);
  console.log(
    "\n常見原因：這個頁面沒有用 Notion「分享到網路」公開、網址打錯、或還沒跑 `npx playwright install chromium`。"
  );
}
