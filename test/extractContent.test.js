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
