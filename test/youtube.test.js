import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isYouTubeUrl,
  youtubeVideoId,
  parseVtt,
  pickSubtitleTrack,
  buildTranscript,
  createYouTubeFetcher,
} from "../src/youtube.js";

test("recognizes YouTube urls and extracts the video id", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abcDEF12345&t=10s",
    "https://youtu.be/abcDEF12345",
    "https://m.youtube.com/watch?v=abcDEF12345",
    "https://www.youtube.com/shorts/abcDEF12345",
    "https://www.youtube.com/live/abcDEF12345",
  ]) {
    assert.equal(isYouTubeUrl(url), true, url);
    assert.equal(youtubeVideoId(url), "abcDEF12345", url);
  }
  assert.equal(isYouTubeUrl("https://example.com/watch?v=abcDEF12345"), false);
});

test("parseVtt de-duplicates YouTube auto-caption rolling lines and strips inline tags", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000 align:start position:0%
hello<00:00:00.500><c> world</c>

00:00:02.000 --> 00:00:02.010 align:start position:0%
hello world


00:00:02.010 --> 00:00:04.000 align:start position:0%
hello world
this<00:00:02.500><c> is</c><c> fine</c>

01:02:03.500 --> 01:02:05.000
最後一句 &amp; 結尾
`;
  assert.deepEqual(parseVtt(vtt), [
    { start: 0, text: "hello world" },
    { start: 2.01, text: "this is fine" },
    { start: 3723.5, text: "最後一句 & 結尾" },
  ]);
});

test("subtitle track priority: manual 繁中 > manual 簡中 > manual 英文 > auto (original language)", () => {
  const track = (lang) => [{ ext: "vtt", url: `https://x/${lang}` }];
  assert.deepEqual(pickSubtitleTrack({ subtitles: { en: track("en"), "zh-Hant": track("zh-Hant"), "zh-Hans": track("zh-Hans") } }), {
    lang: "zh-Hant",
    auto: false,
  });
  assert.deepEqual(pickSubtitleTrack({ subtitles: { en: track("en"), "zh-CN": track("zh-CN") } }), { lang: "zh-CN", auto: false });
  assert.deepEqual(pickSubtitleTrack({ subtitles: { en: track("en") } }), { lang: "en", auto: false });
  assert.deepEqual(
    pickSubtitleTrack({ subtitles: {}, automatic_captions: { "zh-Hant": track("x"), "ja-orig": track("x"), ja: track("x") } }),
    { lang: "ja-orig", auto: true }
  );
  assert.deepEqual(pickSubtitleTrack({ language: "ko", automatic_captions: { ko: track("ko"), en: track("en") } }), {
    lang: "ko",
    auto: true,
  });
  assert.equal(pickSubtitleTrack({ subtitles: { live_chat: track("x") } }), null);
});

test("transcript groups cues into timestamped paragraphs under chapters", () => {
  const cues = [
    { start: 0, text: "開場" },
    { start: 30, text: "介紹" },
    { start: 70, text: "第二段" },
    { start: 125, text: "進入主題" },
  ];
  const md = buildTranscript({
    cues,
    chapters: [
      { start_time: 0, title: "開場白" },
      { start_time: 120, title: "主題" },
    ],
    videoId: "vid",
    paragraphSeconds: 60,
  });
  assert.equal(
    md,
    [
      "### [00:00](https://youtu.be/vid?t=0) 開場白",
      "",
      "[00:00](https://youtu.be/vid?t=0) 開場 介紹",
      "",
      "[01:10](https://youtu.be/vid?t=70) 第二段",
      "",
      "### [02:00](https://youtu.be/vid?t=120) 主題",
      "",
      "[02:05](https://youtu.be/vid?t=125) 進入主題",
    ].join("\n")
  );
});

test("transcript without chapters is just timestamped paragraphs; hours are shown when needed", () => {
  const md = buildTranscript({ cues: [{ start: 3725, text: "晚段" }], chapters: [], videoId: "v" });
  assert.equal(md, "[1:02:05](https://youtu.be/v?t=3725) 晚段");
});

// ---- fetcher（假的 yt-dlp runner）----

const info = {
  id: "vid",
  title: "影片標題",
  channel: "某頻道",
  upload_date: "20260315",
  duration: 3725,
  description: "影片說明文字",
  chapters: null,
  subtitles: { "zh-Hant": [{ ext: "vtt" }] },
};

function fakeYtDlp({ meta = info, vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n大家好\n", fail } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (fail) throw fail;
    if (args.includes("-J")) return JSON.stringify(meta);
    // 下載字幕：-o <模板> 寫出 <模板>.<lang>.vtt
    const out = args[args.indexOf("-o") + 1];
    const lang = args[args.indexOf("--sub-langs") + 1];
    fs.writeFileSync(`${out}.${lang}.vtt`, vtt);
    return "";
  };
  return { run, calls };
}

const webFallback = { fetch: async (url) => ({ url, ok: true, title: "網頁標題", text: "og 描述", byline: "", excerpt: "" }) };

test("fetches metadata + preferred subtitles into a video Source", async () => {
  const { run, calls } = fakeYtDlp();
  const src = await createYouTubeFetcher({ run, web: webFallback }).fetch("https://youtu.be/vid");

  assert.equal(src.ok, true);
  assert.equal(src.kind, "video");
  assert.equal(src.title, "影片標題");
  assert.equal(src.byline, "某頻道");
  assert.equal(src.channel, "某頻道");
  assert.equal(src.published, "2026-03-15");
  assert.equal(src.duration, "1:02:05");
  assert.match(src.text, /影片說明文字/);
  assert.match(src.text, /\[00:01\]\(https:\/\/youtu\.be\/vid\?t=1\) 大家好/);
  assert.equal(src.warning, undefined);
  assert.ok(calls[1].includes("--write-subs"), "manual subtitle uses --write-subs");
});

test("video without subtitles degrades to title + description with a warning", async () => {
  const { run } = fakeYtDlp({ meta: { ...info, subtitles: {}, automatic_captions: {} } });
  const src = await createYouTubeFetcher({ run, web: webFallback }).fetch("https://youtu.be/vid");
  assert.equal(src.ok, true);
  assert.match(src.text, /影片說明文字/);
  assert.match(src.warning, /沒有字幕/);
});

test("missing yt-dlp degrades to the web page with an install hint", async () => {
  const notFound = Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
  const { run } = fakeYtDlp({ fail: notFound });
  const src = await createYouTubeFetcher({ run, web: webFallback }).fetch("https://youtu.be/vid");
  assert.equal(src.ok, true);
  assert.equal(src.kind, "video");
  assert.equal(src.title, "網頁標題");
  assert.match(src.warning, /yt-dlp/);
});

test("temporary subtitle files are cleaned up", async () => {
  const { run, calls } = fakeYtDlp();
  await createYouTubeFetcher({ run, web: webFallback }).fetch("https://youtu.be/vid");
  const outTemplate = calls[1][calls[1].indexOf("-o") + 1];
  assert.equal(fs.existsSync(path.dirname(outTemplate)), false);
});
