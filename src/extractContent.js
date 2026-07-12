import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const URL_RE = /https?:\/\/[^\s<>()"']+/g;

export function findUrls(text) {
  return [...(text.match(URL_RE) || [])];
}

function isNotionUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site");
  } catch {
    return false;
  }
}

/**
 * 抓一個網址並嘗試抽出正文。
 * Notion 頁面走 Playwright（見 fetchNotionViaPlaywright），其他網址走一般 fetch + Readability。
 * 抓不到/被擋掉時回傳 { ok:false, error }，呼叫端要能處理這種情況
 * （例如只靠使用者附的文字說明分類）。
 */
export async function fetchUrlContent(url) {
  if (isNotionUrl(url)) {
    return fetchNotionViaPlaywright(url);
  }
  return fetchViaFetch(url);
}

async function fetchViaFetch(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { url, ok: false, error: `HTTP ${res.status}` };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/markdown")) {
      return { url, ok: false, error: `不支援的內容類型: ${contentType}` };
    }
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article) {
      return { url, ok: false, error: "無法解析文章內容" };
    }
    return {
      url,
      ok: true,
      title: article.title || "",
      byline: article.byline || "",
      excerpt: article.excerpt || "",
      // Readability 回傳的是 HTML，這裡簡單轉成純文字，避免 prompt 塞一堆標籤浪費 token
      text: htmlToText(article.content).slice(0, 12000),
    };
  } catch (err) {
    return { url, ok: false, error: String(err?.message || err) };
  }
}

/**
 * Notion 頁面是重度 JS 渲染的 SPA，plain fetch 拿到的 HTML 只有空殼，
 * 所以用 Playwright 開一個無頭瀏覽器把頁面真正渲染出來再抓文字。
 *
 * 注意：不能用 waitUntil: "networkidle" —— Notion 頁面會維持一條常駐的
 * websocket 連線（即時協作用），網路永遠不會真正「閒置」，networkidle 幾乎一定逾時。
 * 改成 domcontentloaded 先讓頁面骨架載入，再主動輪詢畫面上的文字量，
 * 連續兩次量測沒再變化（或是超過等待上限）就當作渲染穩定了。
 *
 * 只對「已經用 Notion 的『分享到網路』功能公開」的頁面有效——
 * 需要登入的私人頁面會被導去登入畫面，抓到的會是登入頁的文字，不是真正內容
 * （這種情況下 body 文字通常很短、含有「Log in / Sign up」等字樣，
 * classify.js 那邊看到內容太少、太可疑時，AI 應該還是會判斷資料不足）。
 *
 * 動態 import playwright，這樣沒用到 Notion 連結的人不會平白多花啟動時間。
 */
async function fetchNotionViaPlaywright(url) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return {
      url,
      ok: false,
      error:
        "沒有裝 Playwright 或瀏覽器核心，無法讀取 Notion 頁面。請執行 `npm install` 再跑一次 `npx playwright install chromium`。",
    };
  }

  let browser;
  try {
    // channel: "chromium" 強制用完整版 Chromium（新版 headless 模式），
    // 不要用 Playwright 預設的 chromium-headless-shell —— 那個是精簡版，
    // 拿來測 Notion 這種重度 JS 的 SPA 常常整個卡死、連 domcontentloaded 都等不到。
    // 如果那個環境剛好沒裝完整版（例如用 --only-shell 裝的），就退回預設的再試一次。
    try {
      browser = await chromium.launch({ headless: true, channel: "chromium" });
    } catch (channelErr) {
      console.warn(
        `[notion] 找不到完整版 Chromium（channel:"chromium"），退回預設的 headless shell：${channelErr.message}`
      );
      browser = await chromium.launch({ headless: true });
    }
    // 注意：這裡故意不覆寫 userAgent。之前設了一個假的 UA 字串，結果跟 Chromium
    // 實際送出的 Client Hints（Sec-CH-UA 等）對不上，疑似被 Notion 的機器人偵測盯上，
    // 導致頁面整個卡住連 domcontentloaded 都等不到；拿掉自訂 UA、用瀏覽器原生的就正常了。
    const page = await browser.newPage();

    // 只等 DOM 骨架載入完成，不等網路閒置（Notion 的常駐連線會讓 networkidle 永遠等不到）。
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const text = await waitForStableText(page, { maxWaitMs: 25000, pollMs: 500, minLength: 40 });
    const title = (await page.title()) || "";

    await browser.close();

    const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();

    if (!cleaned || cleaned.length < 40) {
      return {
        url,
        ok: false,
        error: "抓到的內容太少，這個 Notion 頁面可能沒有公開分享，或需要登入才能看",
      };
    }

    return {
      url,
      ok: true,
      title,
      byline: "",
      excerpt: "",
      text: cleaned.slice(0, 12000),
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { url, ok: false, error: `Playwright 讀取失敗：${String(err?.message || err)}` };
  }
}

// 輪詢 document.body.innerText 的長度，直到連續兩次量測都沒再增加（視為渲染穩定），
// 或是超過 maxWaitMs 就直接回傳當下抓到的內容（不當成致命錯誤，讓呼叫端自己判斷內容夠不夠）。
async function waitForStableText(page, { maxWaitMs, pollMs, minLength }) {
  const start = Date.now();
  let lastLength = -1;
  let stableRounds = 0;

  while (Date.now() - start < maxWaitMs) {
    const len = await page.evaluate(() => (document.body.innerText || "").length);
    if (len >= minLength && len === lastLength) {
      stableRounds += 1;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastLength = len;
    await page.waitForTimeout(pollMs);
  }

  return page.evaluate(() => document.body.innerText || "");
}

function htmlToText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
