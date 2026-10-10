import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

// 網頁常有 jsdom 解析不了的 CSS，錯誤訊息對抽正文沒有影響，不要洗版。
const quietConsole = new VirtualConsole();

// 全形標點（，。「」等）不會出現在網址裡，遇到就當網址結束，避免「https://a.com/x。順便...」整串被吃進去。
const URL_RE = /https?:\/\/[^\s<>()"'，。；：、「」『』！？（）]+/g;

// 從一段文字裡抓出所有網址（可能出現在句子中間）。緊黏在網址後面的常見尾端標點
// （中英文句號、逗號、括號、引號等）會被一起吃進去，所以額外清掉。
// 一般內容收件跟 /notebook 研究共用這支。
export function findUrls(text) {
  return (text.match(URL_RE) || []).map((u) => u.replace(/[)\]}>,.;:!?，。；：、」』"'"]+$/, ""));
}

function isNotionUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site");
  } catch {
    return false;
  }
}

// 解常見的 HTML entity，給 og:title / og:description 這種直接從原始 HTML 屬性裡
// 正則抓出來的字串用（沒有經過瀏覽器 DOM 解析，& quot; 之類的符號要自己轉回來）。
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// 抓 <meta property="og:xxx" content="..."> ——屬性順序不一定，兩種寫法都試。
function extractOgMeta(html) {
  const get = (prop) => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) return decodeHtmlEntities(m[1]);
    }
    return "";
  };
  return { title: get("title"), description: get("description") };
}

// Readability 是為長篇文章設計的，遇到 Threads/X/Instagram 這種短貼文、
// 或是重度 JS 渲染、伺服器端幾乎沒吐出可讀內文的頁面，常常直接回傳 null，
// 或是抓到的內容短到沒意義。這個門檻用來判斷「要不要退而求其次改用 og:description」。
const MIN_READABLE_TEXT_LENGTH = 40;

// 一般抓取拿到的正文少於這個長度，就再用瀏覽器抓一次看看（取比較完整的那份）。
// 常見於：只拿到 og:description 的社群貼文、伺服器端只吐骨架的 SPA。
const RICH_TEXT_LENGTH = 500;

// 原文盡量完整交給 AI（精讀筆記要保留細節）。8 萬字約等於一本小冊子，超過才截斷，避免極端頁面塞爆 prompt。
const MAX_SOURCE_CHARS = 80_000;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Cloudflare 之類的「確認你是真人」頁面：瀏覽器抓到的是這種頁面就當成失敗，不要把驗證頁當內文。
const CHALLENGE_TITLE = /請稍候|Just a moment|Attention Required|Access denied|Verify you are human/i;
const CHALLENGE_WAIT_MS = 20_000;

// Readability 抽正文並轉成 Markdown；抽不到夠長的內容回傳 null。
function parseArticleHtml(html, url) {
  const article = new Readability(new JSDOM(html, { url, virtualConsole: quietConsole }).window.document).parse();
  const text = article ? htmlToMarkdown(article.content) : "";
  if (!article || text.trim().length < MIN_READABLE_TEXT_LENGTH) return null;
  return {
    title: article.title || "",
    byline: article.byline || "",
    excerpt: article.excerpt || "",
    published: (article.publishedTime || "").slice(0, 10),
    text: text.slice(0, MAX_SOURCE_CHARS),
  };
}

/**
 * 一般抓取：fetch + Readability。抓不到/被擋掉時回傳 { ok:false, error }。
 */
async function fetchViaFetch(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": BROWSER_USER_AGENT },
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
    const article = parseArticleHtml(html, url);
    if (article) return { url, ok: true, ...article };

    // Readability 抓不到夠長的正文：常見於 Threads、X（Twitter）、Instagram 這類短文社群貼文，
    // 或是頁面本身重度 JS 渲染、伺服器端沒吐出可讀內文。這類平台為了連結預覽，原始 HTML 裡
    // 通常就有 og:title / og:description，退而求其次改抓這個（之後還會再試瀏覽器抓取）。
    const ogMeta = extractOgMeta(html);
    if (ogMeta.description || ogMeta.title) {
      return {
        url,
        ok: true,
        title: ogMeta.title,
        byline: "",
        excerpt: ogMeta.description,
        text: [ogMeta.title, ogMeta.description].filter(Boolean).join("\n\n"),
      };
    }
    return { url, ok: false, error: "無法解析文章內容" };
  } catch (err) {
    return { url, ok: false, error: String(err?.message || err) };
  }
}

/**
 * 瀏覽器抓取：用 Playwright 開無頭 Chromium 把頁面真正渲染出來再抽正文。
 * 用在：Notion 這類重度 JS 的 SPA、一般抓取被擋（HTTP 403，例如 Dcard、樂吃購）或內容太短的頁面。
 *
 * - channel: "chromium" 用完整版 Chromium 的新版 headless 模式，不用 Playwright 預設的
 *   chromium-headless-shell：精簡版跑重度 JS 的 SPA 常常卡死，也比較容易被防爬蟲（Cloudflare）擋下。
 *   環境沒裝完整版（例如用 --only-shell 裝的）就退回預設的再試一次。
 * - 不覆寫 userAgent：假的 UA 跟 Chromium 實際送出的 Client Hints 對不上，反而會被機器人偵測盯上。
 * - 不能用 waitUntil: "networkidle"：Notion 等頁面有常駐連線，網路永遠不會閒置。
 *   改成 domcontentloaded 後輪詢畫面文字量，連續兩次沒再變化就當作渲染穩定。
 * - 需要登入的私人頁面抓到的會是登入頁，內容通常很短，AI 會判斷資料不足。
 *
 * 動態 import playwright，沒用到瀏覽器抓取的人不會平白多花啟動時間。
 */
async function fetchViaBrowser(url) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {
      url,
      ok: false,
      error: "沒有裝 Playwright 或瀏覽器核心，無法用瀏覽器抓取。請執行 `pnpm exec playwright install chromium`。",
    };
  }

  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true, channel: "chromium" });
    } catch (channelErr) {
      console.warn(`[fetch] 找不到完整版 Chromium（channel:"chromium"），退回預設的 headless shell：${channelErr.message}`);
      browser = await chromium.launch({ headless: true });
    }
    // 新版 headless 的預設 UA 帶有「HeadlessChrome」，會被 Cloudflare 直接攔下。
    // 只把這個字換掉、其餘沿用瀏覽器自己的 UA，版本號才會跟 Client Hints 一致（自己亂填反而更容易被盯上）。
    const userAgent = (await browser.newPage().then(async (p) => {
      const ua = await p.evaluate(() => navigator.userAgent);
      await p.close();
      return ua;
    })).replace("HeadlessChrome", "Chrome");
    const page = await browser.newPage({ locale: "zh-TW", userAgent });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (response?.status() === 429) {
      await browser.close();
      return { url, ok: false, error: "網站暫時限制存取（HTTP 429：短時間內請求太多次），晚點再試通常就會恢復" };
    }

    // Cloudflare 的驗證頁通常幾秒內會自己跑完 JS 檢查並跳轉，等它一下。
    for (let waited = 0; waited < CHALLENGE_WAIT_MS && CHALLENGE_TITLE.test(await page.title()); waited += 1000) {
      await page.waitForTimeout(1000);
    }

    const innerText = await waitForStableText(page, { maxWaitMs: 25000, pollMs: 500, minLength: 40 });
    const title = (await page.title()) || "";
    const html = await page.content();
    await browser.close();

    if (CHALLENGE_TITLE.test(title)) {
      return { url, ok: false, error: "被網站的防爬蟲驗證擋下（需要真人驗證）" };
    }

    const article = parseArticleHtml(html, url);
    if (article) return { url, ok: true, ...article, title: article.title || title };

    const cleaned = innerText.replace(/\n{3,}/g, "\n\n").trim();
    if (cleaned.length < MIN_READABLE_TEXT_LENGTH) {
      return { url, ok: false, error: "抓到的內容太少，頁面可能沒有公開，或需要登入才能看" };
    }
    return { url, ok: true, title, byline: "", excerpt: "", text: cleaned.slice(0, MAX_SOURCE_CHARS) };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { url, ok: false, error: `瀏覽器讀取失敗：${String(err?.message || err)}` };
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

/**
 * Fetcher adapter：fetch(url) -> Source（{ url, ok, title, byline, excerpt, published, text } 或 { url, ok:false, error }）。
 * 備援規則：Notion 直接用瀏覽器；其他先一般抓取，失敗或內容太短再用瀏覽器抓，取比較完整的那份；
 * 兩邊都失敗時，error 同時列出兩邊的原因。
 */
export function createWebFetcher({ fetchStatic = fetchViaFetch, fetchBrowser = fetchViaBrowser } = {}) {
  return {
    async fetch(url) {
      if (isNotionUrl(url)) return fetchBrowser(url);

      const first = await fetchStatic(url);
      if (first.ok && first.text.length >= RICH_TEXT_LENGTH) return first;

      const second = await fetchBrowser(url);
      if (second.ok && (!first.ok || second.text.length > first.text.length)) return second;
      if (first.ok) return first;
      return { url, ok: false, error: `一般抓取：${first.error}；瀏覽器抓取：${second.error}` };
    },
  };
}


const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION", "TABLE", "TR"]);
const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,pre,ul,ol,blockquote,p,div,section,table";
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "BUTTON", "FORM"]);

// Readability 回傳的正文 HTML 轉成 Markdown：保留標題層級、清單、程式碼區塊、引用、連結，
// 讓 AI 能「依原文章節」整理，程式碼也不會被壓成一行。
// ponytail: 只處理文章常見標籤；表格攤平成每列一行，需要時再換 turndown 之類的套件。
export function htmlToMarkdown(html) {
  const { document } = new JSDOM(`<body>${html}</body>`, { virtualConsole: quietConsole }).window;

  function inline(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.textContent.replace(/\s+/g, " ");
        continue;
      }
      if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName)) continue;
      const text = inline(child);
      switch (child.tagName) {
        case "CODE": // 多行的 <code>（沒有包在 <pre> 裡）也當成程式碼區塊
          out += child.textContent.includes("\n") ? `\n\`\`\`\n${child.textContent}\n\`\`\`\n` : `\`${child.textContent}\``;
          break;
        case "A": {
          const href = child.getAttribute("href") || "";
          out += /^https?:/.test(href) && text.trim() ? `[${text.trim()}](${href})` : text;
          break;
        }
        case "STRONG":
        case "B":
          out += text.trim() ? `**${text.trim()}**` : "";
          break;
        case "BR":
          out += "\n";
          break;
        default:
          out += BLOCK_TAGS.has(child.tagName) || /^H[1-6]$/.test(child.tagName) ? `\n${text}\n` : text;
      }
    }
    return out;
  }

  function block(node, out = []) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.textContent.trim()) out.push(child.textContent.trim());
        continue;
      }
      if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName)) continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) {
        out.push(`${"#".repeat(Number(tag[1]))} ${inline(child).trim()}`);
      } else if (tag === "PRE") {
        const lang = (child.querySelector("code")?.className.match(/language-(\S+)/) || [])[1] || "";
        out.push(`\`\`\`${lang}\n${child.textContent.replace(/\n$/, "")}\n\`\`\``);
      } else if (tag === "UL" || tag === "OL") {
        const items = [...child.children].filter((li) => li.tagName === "LI");
        const lines = items.map((li) => inline(li).trim()).filter(Boolean); // 只有錨點連結的目錄項目會是空的
        if (lines.length) out.push(lines.map((text, i) => `${tag === "OL" ? `${i + 1}.` : "-"} ${text}`).join("\n"));
      } else if (tag === "BLOCKQUOTE") {
        out.push(block(child, []).join("\n\n").split("\n").map((line) => `> ${line}`).join("\n"));
      } else if (child.querySelector(BLOCK_SELECTOR)) {
        block(child, out); // 容器（含 <is-land> 這類自訂元素）裡還有區塊元素，往下拆
      } else {
        const text = inline(child).trim();
        if (text) out.push(text);
      }
    }
    return out;
  }

  return block(document.body).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
