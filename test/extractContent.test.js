import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, findUrls } from "../src/extractContent.js";

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
