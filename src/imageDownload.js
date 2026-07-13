import fs from "node:fs";
import path from "node:path";

// 共用的圖片下載工具，給 eagleImageArchive.js（備份到獨立 git repo）和
// imageEmbed.js（內嵌進筆記所在的 vault 資料夾）兩邊一起用，避免同一套
// 下載/猜副檔名/檔名去重邏輯散落在兩個檔案裡、之後改一邊忘了改另一邊。

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB 上限，避免抓到影片之類離譜大的檔案

export function guessExtension(url, contentType) {
  const fromUrl = url.split("?")[0].split("#")[0];
  const extMatch = fromUrl.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (extMatch) return extMatch[1].toLowerCase();
  if (contentType?.includes("jpeg")) return "jpg";
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("gif")) return "gif";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("svg")) return "svg";
  return "jpg";
}

export function sanitizeBaseName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 80) || "image";
}

/**
 * 下載一張圖片的位元組內容。逾時、非 2xx、檔案太大都會丟出例外，
 * 呼叫端自己決定要不要略過這一張、繼續處理其他張。
 */
export async function downloadImageBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`檔案太大（${(buf.length / 1024 / 1024).toFixed(1)}MB），跳過`);
  }
  return { buf, ext: guessExtension(url, contentType) };
}

/**
 * 在 dirAbs 這個資料夾裡找一個還沒被用過的檔名（baseName + 序號 + 副檔名），
 * 有重複就加上 " (2)"、" (3)"... 直到找到空位，絕不覆蓋既有檔案。
 */
export function pickAvailableFilename(dirAbs, baseName, index, total, ext) {
  const suffix = total > 1 ? `-${index + 1}` : "";
  let filename = `${baseName}${suffix}.${ext}`;
  let counter = 2;
  while (fs.existsSync(path.join(dirAbs, filename))) {
    filename = `${baseName}${suffix} (${counter}).${ext}`;
    counter += 1;
  }
  return filename;
}
