import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, findUrls, createWebFetcher, parseArticleHtml } from "../src/extractContent.js";

test("keeps article structure: headings, lists, code blocks, inline code, links", () => {
  const md = htmlToMarkdown(`
    <h2>安裝</h2>
    <p>先執行 <code>pnpm i</code>，詳見 <a href="https://x.dev/docs">文件</a>。</p>
    <ol><li>第一步</li><li>第二步</li></ol>
    <ul><li>重點 A</li></ul>
    <pre><code class="language-js">const a = 1;
if (a) {
  run();
}</code></pre>
    <blockquote><p>引用一句</p></blockquote>
    <script>evil()</script>
  `);

  assert.match(md, /^## 安裝$/m);
  assert.match(md, /先執行 `pnpm i`，詳見 \[文件\]\(https:\/\/x\.dev\/docs\)。/);
  assert.match(md, /^1\. 第一步$/m);
  assert.match(md, /^2\. 第二步$/m);
  assert.match(md, /^- 重點 A$/m);
  assert.match(md, /```js\nconst a = 1;\nif \(a\) \{\n  run\(\);\n\}\n```/);
  assert.match(md, /^> 引用一句$/m);
  assert.doesNotMatch(md, /evil/);
});

test("long articles are not truncated to a few thousand characters", () => {
  const md = htmlToMarkdown(`<p>${"字".repeat(30000)}</p>`);
  assert.ok(md.length >= 30000);
});

test("findUrls stops at full-width punctuation and trims trailing punctuation", () => {
  assert.deepEqual(findUrls("看 https://a.com/x。順便 https://b.com/y)"), ["https://a.com/x", "https://b.com/y"]);
});

test("code blocks nested in custom elements (e.g. <is-land>) stay fenced", () => {
  const md = htmlToMarkdown(`<div><is-land><div><pre><island-slot><code>a();\nb();</code></island-slot></pre></div></is-land></div>`);
  assert.match(md, /```\na\(\);\nb\(\);\n```/);
});

// 假的 static / browser 抓取，記錄被呼叫的順序
function fetcherWith({ staticResult, browserResult }) {
  const calls = [];
  const fetcher = createWebFetcher({
    fetchStatic: async (url) => (calls.push("static"), { url, ...staticResult }),
    fetchBrowser: async (url) => (calls.push("browser"), { url, ...browserResult }),
  });
  return { fetcher, calls };
}
const long = "內".repeat(800);

test("static fetch with enough content is used directly, no browser", async () => {
  const { fetcher, calls } = fetcherWith({ staticResult: { ok: true, text: long } });
  assert.equal((await fetcher.fetch("https://a.com")).text, long);
  assert.deepEqual(calls, ["static"]);
});

test("static fetch blocked (403) falls back to the browser", async () => {
  const { fetcher, calls } = fetcherWith({
    staticResult: { ok: false, error: "HTTP 403" },
    browserResult: { ok: true, text: long },
  });
  const r = await fetcher.fetch("https://www.dcard.tw/f/travel/p/1");
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["static", "browser"]);
});

test("static content too short tries the browser and keeps the longer one", async () => {
  const short = { ok: true, text: "og 描述而已" };
  assert.equal((await fetcherWith({ staticResult: short, browserResult: { ok: true, text: long } }).fetcher.fetch("https://a.com")).text, long);
  assert.equal((await fetcherWith({ staticResult: short, browserResult: { ok: false, error: "x" } }).fetcher.fetch("https://a.com")).text, "og 描述而已");
});

test("both failing reports both reasons", async () => {
  const { fetcher } = fetcherWith({
    staticResult: { ok: false, error: "HTTP 403" },
    browserResult: { ok: false, error: "被網站的防爬蟲驗證擋下" },
  });
  const r = await fetcher.fetch("https://a.com");
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 403[\s\S]*防爬蟲/);
});

test("notion pages go straight to the browser", async () => {
  const { fetcher, calls } = fetcherWith({ browserResult: { ok: true, text: long } });
  await fetcher.fetch("https://foo.notion.site/page");
  assert.deepEqual(calls, ["browser"]);
});

// 一篇夠長、Readability 認得出來的文章頁，給 parseArticleHtml 的測試共用。
const articlePage = ({ head = "", header = "", main = "", footer = "" } = {}) => `<!doctype html><html><head><title>文章標題</title>${head}</head><body>
  ${header}
  <article><h1>文章標題</h1>${main || `<p>${"這是正文段落，內容夠長讓 Readability 認得出來。".repeat(20)}</p>`}</article>
  ${footer}
</body></html>`;

test("parseArticleHtml turns a plain HTML string into a Source", () => {
  const source = parseArticleHtml(articlePage(), { url: "https://a.com/post/1", finalUrl: "https://a.com/post/1" });
  assert.equal(source.title, "文章標題");
  assert.match(source.text, /這是正文段落/);
});

test("provider hints come from the header logo alt, og:site_name and copyright line", () => {
  const source = parseArticleHtml(
    articlePage({
      head: `<meta property="og:site_name" content="大榮旅遊官網">`,
      header: `<header><a href="/"><img alt="大榮旅遊" src="/logo.png"></a></header>`,
      footer: `<footer><p>Copyright © 2026 大榮旅行社股份有限公司 All rights reserved.</p></footer>`,
    }),
    { url: "https://www.dtsgroup.com.tw/group/X" }
  );
  assert.ok(source.providerHints.includes("大榮旅遊"));
  assert.ok(source.providerHints.includes("大榮旅遊官網"));
  assert.ok(source.providerHints.some((h) => h.includes("大榮旅行社股份有限公司")));
});

test("no provider clues gives an empty hint list", () => {
  assert.deepEqual(parseArticleHtml(articlePage(), { url: "https://a.com/p" }).providerHints, []);
});

test("when Readability grabs only a small block, the whole readable page is used", () => {
  // 仿大榮旅遊行程頁：售價、航班、每日行程都是零碎的 <span>，Readability 只挑中「注意事項」那段長文。
  const days = Array.from({ length: 5 }, (_, i) =>
    `<div><div><span>第 ${i + 1} 天</span></div><div><span>行程</span><span>登別地獄谷／洞爺湖畔散策／小樽運河自由散策</span></div>` +
    `<div><span>餐食</span><span>早餐：飯店內 午餐：日式壽喜燒</span></div><div><span>住宿</span><span>登別石水亭(或)同級</span></div></div>`
  ).join("");
  const html = `<!doctype html><html><head><title>北海道五日</title></head><body>
    <nav><a href="/">首頁</a><a href="/group">團體旅遊</a></nav>
    <div><span>售價</span><span>NT$37,900 起</span></div><div><span>去程</span><span>長榮航空 BR116</span></div>
    <div>${days}</div>
    <div><h2>注意事項</h2><p>${"團體機票不能延回也不能退票，護照效期需六個月以上。".repeat(6)}</p><p>${"導遊司機小費每人每日新台幣三百元另付，十六人才成團。".repeat(6)}</p></div>
    <footer><a href="/about">關於我們</a></footer>
  </body></html>`;

  const source = parseArticleHtml(html, { url: "https://a.com/group/X" });

  assert.match(source.text, /第 3 天/);
  assert.match(source.text, /NT\$37,900 起/);
  assert.match(source.text, /BR116/);
  assert.match(source.text, /團體機票不能延回/);
  assert.doesNotMatch(source.text, /關於我們/);
  assert.doesNotMatch(source.text, /團體旅遊/);
});

test("a normal article keeps Readability's extract and leaves the sidebar out", () => {
  const html = articlePage({
    footer: `<aside><h3>推薦文章</h3><ul><li><a href="/x">別篇文章標題</a></li></ul></aside>`,
  });
  const source = parseArticleHtml(html, { url: "https://a.com/post/1" });
  assert.match(source.text, /這是正文段落/);
  assert.doesNotMatch(source.text, /別篇文章標題/);
});

test("content images become Markdown images with their alt text", () => {
  const md = htmlToMarkdown(`<p>架構如下：</p><figure><img src="https://a.com/img/arch.png" alt="系統架構圖"></figure><p>說明 <img src="https://a.com/img/inline.jpg" alt="流程"> 結束</p>`);
  assert.match(md, /!\[系統架構圖\]\(https:\/\/a\.com\/img\/arch\.png\)/);
  assert.match(md, /!\[流程\]\(https:\/\/a\.com\/img\/inline\.jpg\)/);
});

test("logos, icons, data URIs and src-less images are dropped", () => {
  const md = htmlToMarkdown(`<p>文字
    <img src="https://a.com/logo.png" alt="品牌">
    <img src="https://a.com/x.png" class="site-icon" alt="">
    <img src="https://a.com/y.png" alt="icon">
    <img src="data:image/png;base64,AAAA" alt="像素">
    <img alt="沒有網址"></p>`);
  assert.doesNotMatch(md, /!\[/);
});

test("an image sitting next to paragraphs is kept", () => {
  const md = htmlToMarkdown(`<div><p>上一段</p><img src="https://a.com/shot.png" alt="截圖"><p>下一段</p></div>`);
  assert.match(md, /!\[截圖\]\(https:\/\/a\.com\/shot\.png\)/);
});

test("redirected to the home page counts as the wrong page", () => {
  const source = parseArticleHtml(articlePage(), {
    url: "https://ai-chain.tw/blog/codeburn-ai-coding-cost-dashboard/",
    finalUrl: "https://ai-chain.tw/",
  });
  assert.match(source.wrongPage, /首頁/);
});

test("an article that is itself the home page is not the wrong page", () => {
  assert.equal(parseArticleHtml(articlePage(), { url: "https://a.com/", finalUrl: "https://a.com/" }).wrongPage, undefined);
});

test("wrong page from both fetchers is reported as wrong_page, not merged into a generic error", async () => {
  const wrong = (url) => ({ url, ok: false, errorKind: "wrong_page", error: "被導向網站首頁" });
  const fetcher = createWebFetcher({ fetchStatic: async (u) => wrong(u), fetchBrowser: async (u) => wrong(u) });
  const out = await fetcher.fetch("https://a.com/post/1");
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, "wrong_page");
});

test("an article URL that serves the home page (canonical points to /) counts as the wrong page", () => {
  const source = parseArticleHtml(articlePage({ head: `<link rel="canonical" href="https://ai-chain.tw/">` }), {
    url: "https://ai-chain.tw/blog/codeburn-ai-coding-cost-dashboard/",
  });
  assert.match(source.wrongPage, /首頁/);
});

test("a malformed canonical link does not break parsing", () => {
  const source = parseArticleHtml(articlePage({ head: `<link rel="canonical" href="http://[bad">` }), { url: "https://a.com/post/1" });
  assert.equal(source.wrongPage, undefined);
  assert.match(source.text, /這是正文段落/);
});

test("review: images and links in the whole-page fallback keep absolute URLs", () => {
  // 跟上面「Readability 只挑中一小塊」同一種頁面，確定走整頁 fallback
  const days = Array.from({ length: 5 }, (_, i) =>
    `<div><div><span>第 ${i + 1} 天</span></div><div><span>行程</span><span>登別地獄谷／洞爺湖畔散策／小樽運河自由散策</span></div>` +
    `<div><span>餐食</span><span>早餐：飯店內 午餐：日式壽喜燒</span></div><div><span>住宿</span><span>登別石水亭(或)同級</span></div></div>`
  ).join("");
  const html = `<!doctype html><html><head><title>北海道五日</title></head><body>
    <div><span>售價</span><span>NT$37,900 起</span><img src="/upload/day1.jpg" alt="第一天景點"></div>
    <div>${days}</div>
    <div><h2>注意事項</h2><p>${"團體機票不能延回也不能退票，護照效期需六個月以上。".repeat(6)}</p><p>${"導遊司機小費每人每日新台幣三百元另付，十六人才成團。".repeat(6)}</p></div>
  </body></html>`;
  const source = parseArticleHtml(html, { url: "https://a.com/group/X" });
  assert.match(source.text, /NT\$37,900 起/, "fallback is in use");
  assert.match(source.text, /!\[第一天景點\]\(https:\/\/a\.com\/upload\/day1\.jpg\)/);
});

test("review: words like 'iconic' or 'silicon' do not get content images dropped", () => {
  const md = htmlToMarkdown(`<p><img src="https://cdn.site.com/2026/silicon-valley-map.png" alt="iconic view of Fuji"></p>`);
  assert.match(md, /!\[iconic view of Fuji\]/);
});
