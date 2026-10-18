import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// YouTube 影片：用 yt-dlp 取得影片資訊與字幕，轉成「帶時間戳連結的逐字稿」交給 AI 整理成筆記。
// yt-dlp 是外部 CLI（跟 notebooklm 一樣不是 npm 套件），是可替換的 seam：正式環境用 createYtDlpRunner()，
// 測試傳照劇本回應的假 run。沒裝 yt-dlp 或影片沒字幕時降級成「標題 + 說明」並附上 warning，不中斷流程。

const META_TIMEOUT_MS = 60_000;
const SUBTITLE_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 80_000;
const DEFAULT_PARAGRAPH_SECONDS = 60;

const INSTALL_HINT = "安裝方式：Windows `winget install yt-dlp.yt-dlp`、macOS `brew install yt-dlp`、Linux `pipx install yt-dlp`";

export function isYouTubeUrl(url) {
  return youtubeVideoId(url) !== null;
}

export function youtubeVideoId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (host !== "youtube.com") return null;
  if (u.pathname === "/watch") return u.searchParams.get("v");
  const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
  return m ? m[2] : null;
}

/** yt-dlp CLI adapter：run(args) -> stdout。找不到指令時保留原始錯誤（err.code === "ENOENT"）。 */
export function createYtDlpRunner(command) {
  return function run(args, { timeoutMs = META_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`yt-dlp 逾時（超過 ${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`yt-dlp 結束代碼 ${code}：${stderr.trim().slice(-500) || "(無錯誤訊息)"}`));
      });
    });
  };
}

function parseTimestamp(ts) {
  const parts = ts.split(":").map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * WebVTT -> [{ start（秒）, text }]。
 * YouTube 自動字幕是「滾動式」：每個 cue 會重複上一個 cue 的那一行，再加上新的一行，
 * 所以只保留「上一個 cue 沒出現過」的行，不然逐字稿每句都會重複兩次。
 */
export function parseVtt(vtt) {
  const cues = [];
  let prevLines = new Set();
  for (const block of vtt.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue;
    const start = parseTimestamp(lines[timingIdx].split("-->")[0].trim());
    const textLines = lines
      .slice(timingIdx + 1)
      .map((l) => decodeEntities(l.replace(/<[^>]+>/g, "")).trim())
      .filter(Boolean);
    const fresh = textLines.filter((l) => !prevLines.has(l));
    if (fresh.length) cues.push({ start, text: fresh.join(" ") });
    if (textLines.length) prevLines = new Set(textLines);
  }
  return cues;
}

// 人工字幕依語言優先：繁中 > 簡中 > 英文（簡中、英文由 AI 整理成繁中筆記，不另外轉換）。
const MANUAL_PRIORITY = [/^zh-(TW|Hant|HK|MO)/i, /^zh(-(Hans|CN|SG))?$/i, /^en/i];

/** 從 yt-dlp 的影片資訊挑字幕軌：人工字幕優先，沒有才用自動字幕（優先影片原始語言）。沒有字幕回傳 null。 */
export function pickSubtitleTrack(info) {
  const manual = Object.keys(info.subtitles || {}).filter((lang) => lang !== "live_chat");
  for (const pattern of MANUAL_PRIORITY) {
    const lang = manual.find((l) => pattern.test(l));
    if (lang) return { lang, auto: false };
  }

  // 自動字幕清單裡大多是「機器翻譯成各國語言」的版本，品質差；優先原始語言（-orig 或影片的 language）。
  const auto = Object.keys(info.automatic_captions || {});
  const lang =
    auto.find((l) => l.endsWith("-orig")) ||
    (info.language && auto.find((l) => l === info.language)) ||
    auto.find((l) => /^en/i.test(l));
  return lang ? { lang, auto: true } : null;
}

export function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const timeLink = (seconds, videoId) => `[${formatTime(seconds)}](https://youtu.be/${videoId}?t=${Math.floor(seconds)})`;

/**
 * 逐字稿 Markdown：有章節就用 ### 章節標題分段；段落每 paragraphSeconds 秒一段，段首是可點的時間戳連結。
 * 沒有章節時只給時間戳段落，由 AI 依主題分段。
 */
export function buildTranscript({ cues, chapters = [], videoId, paragraphSeconds = DEFAULT_PARAGRAPH_SECONDS }) {
  const sortedChapters = [...(chapters || [])].sort((a, b) => a.start_time - b.start_time);
  const chapterAt = (t) => sortedChapters.filter((c) => c.start_time <= t).pop() || null;

  const blocks = [];
  let currentChapter;
  let paragraph = null;
  const flush = () => {
    if (paragraph) blocks.push(`${timeLink(paragraph.start, videoId)} ${paragraph.texts.join(" ")}`);
    paragraph = null;
  };

  for (const cue of cues) {
    const chapter = chapterAt(cue.start);
    if (chapter && chapter !== currentChapter) {
      flush();
      blocks.push(`### ${timeLink(chapter.start_time, videoId)} ${chapter.title}`);
      currentChapter = chapter;
    }
    if (paragraph && cue.start - paragraph.start >= paragraphSeconds) flush();
    if (!paragraph) paragraph = { start: cue.start, texts: [] };
    paragraph.texts.push(cue.text);
  }
  flush();
  return blocks.join("\n\n");
}

/**
 * Fetcher adapter（影片）：fetch(url) -> Source，kind 為 "video"，另外帶 channel、duration；
 * 降級時多一個 warning（給筆記與 Telegram 回覆顯示）。
 * @param {{ run: Function, web: { fetch: Function } }} deps  web：沒有 yt-dlp 時退回一般網頁抓取
 */
export function createYouTubeFetcher({ run, web }) {
  async function downloadTranscript(url, track, meta) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-sub-"));
    try {
      const out = path.join(dir, "sub");
      await run(
        [
          "--skip-download",
          track.auto ? "--write-auto-subs" : "--write-subs",
          "--sub-langs",
          track.lang,
          "--sub-format",
          "vtt",
          "--no-warnings",
          "-o",
          out,
          url,
        ],
        { timeoutMs: SUBTITLE_TIMEOUT_MS }
      );
      const vtt = fs.readFileSync(`${out}.${track.lang}.vtt`, "utf8");
      return buildTranscript({ cues: parseVtt(vtt), chapters: meta.chapters, videoId: meta.id });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    async fetch(url) {
      let meta;
      try {
        meta = JSON.parse(await run(["-J", "--skip-download", "--no-warnings", url], { timeoutMs: META_TIMEOUT_MS }));
      } catch (err) {
        const reason =
          err.code === "ENOENT" ? `沒有安裝 yt-dlp，無法讀取影片字幕（${INSTALL_HINT}）` : `yt-dlp 讀取影片失敗（${err.message}）`;
        const page = await web.fetch(url);
        return { ...page, kind: "video", warning: `${reason}，筆記只依網頁標題與描述整理` };
      }

      const description = (meta.description || "").trim();
      const base = {
        url,
        ok: true,
        kind: "video",
        title: meta.title || "",
        byline: meta.channel || meta.uploader || "",
        channel: meta.channel || meta.uploader || "",
        published: /^\d{8}$/.test(meta.upload_date || "")
          ? `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6)}`
          : "",
        duration: meta.duration ? formatTime(meta.duration) : "",
        excerpt: description.slice(0, 300),
      };
      const descriptionBlock = `影片說明：\n${description || "（無）"}`;

      const track = pickSubtitleTrack(meta);
      if (!track) {
        return { ...base, text: descriptionBlock, warning: "這支影片沒有字幕，筆記只依標題與影片說明整理" };
      }

      try {
        const transcript = await downloadTranscript(url, track, meta);
        const label = `逐字稿（${track.lang}${track.auto ? "，自動產生的字幕" : ""}）`;
        return { ...base, text: `${descriptionBlock}\n\n${label}：\n${transcript}`.slice(0, MAX_TRANSCRIPT_CHARS) };
      } catch (err) {
        return { ...base, text: descriptionBlock, warning: `字幕下載失敗（${err.message}），筆記只依標題與影片說明整理` };
      }
    },
  };
}
