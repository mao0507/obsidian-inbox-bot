import fs from "node:fs";
import path from "node:path";
import { vaultFilePath } from "./config.js";
import { downloadImageBytes, sanitizeBaseName, pickAvailableFilename } from "./imageDownload.js";

/**
 * 把文章裡的圖片下載下來，直接存進筆記即將寫入的那個 vault 資料夾（跟 .md 檔同一層），
 * 讓筆記可以用 Obsidian 的 ![[檔名]] 內嵌語法把圖片直接顯示在筆記內容裡，
 * 不用另外開 Eagle App 或點連結才看得到圖。
 *
 * 這些檔案存在 vault 裡，本來就會被 VAULT_GIT_REMOTE 的同步機制（如果有設定）一起帶走，
 * 不需要另外設定 git remote。個別圖片下載失敗會跳過，不影響其他張、也不影響筆記照常寫入。
 *
 * 回傳的 filenames 只有檔名（不含路徑），因為 writeNote.js 產生 ![[檔名]] 時
 * 不需要知道完整路徑——Obsidian 的 wikilink 內嵌語法是全庫唯一檔名查找，不用寫相對路徑。
 */
export async function embedImagesInVault({ folder, images, title }) {
  if (!images || images.length === 0) return { filenames: [], failed: 0 };

  const dirAbs = vaultFilePath(...folder.split("/"));
  fs.mkdirSync(dirAbs, { recursive: true });

  const baseName = sanitizeBaseName(title);
  const filenames = [];
  let failed = 0;

  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const { buf, ext } = await downloadImageBytes(url);
      const filename = pickAvailableFilename(dirAbs, baseName, i, images.length, ext);
      fs.writeFileSync(path.join(dirAbs, filename), buf);
      filenames.push(filename);
    } catch (err) {
      failed += 1;
      console.warn(`[image-embed] 下載圖片失敗，略過內嵌：${url}（${err.message}）`);
    }
  }

  return { filenames, failed };
}
