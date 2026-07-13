import fs from "node:fs";
import path from "node:path";
import { EAGLE_GIT_ENABLED, EAGLE_IMAGES_PATH, EAGLE_GIT_REMOTE, EAGLE_GIT_BRANCH } from "./config.js";
import { createGitSync } from "./gitSyncFactory.js";
import { downloadImageBytes, sanitizeBaseName, pickAvailableFilename } from "./imageDownload.js";

const DEFAULT_GITIGNORE = `.DS_Store
Thumbs.db
`;

const eagleImagesGit = createGitSync({
  repoPath: EAGLE_IMAGES_PATH,
  remoteUrl: EAGLE_GIT_REMOTE,
  branch: EAGLE_GIT_BRANCH,
  label: "eagle-images-git",
  defaultGitignore: DEFAULT_GITIGNORE,
});

/**
 * 把文章裡抓到的圖片下載到本機資料夾（依 Obsidian 分類路徑建同構資料夾），
 * 再 commit + push 到 EAGLE_GIT_REMOTE。
 *
 * 跟 eagleSync.js（呼叫 Eagle App 本機 API）是兩條完全獨立的路徑：這邊只是單純把
 * 圖片檔案本身備份進你自己的 git repo，不需要 Eagle App 開著也能動作，兩邊可以同時啟用、
 * 也可以只啟用其中一個。
 *
 * 沒設定 EAGLE_GIT_REMOTE、或這篇筆記沒有圖片時直接跳過（attempted:false）。
 * 個別圖片下載失敗不會讓整批失敗，會略過那張、繼續處理其他張。
 */
export async function archiveImagesToGit({ images, folder, title }) {
  if (!EAGLE_GIT_ENABLED) return { attempted: false };
  if (!images || images.length === 0) return { attempted: false };

  const dirAbs = path.join(EAGLE_IMAGES_PATH, ...folder.split("/"));
  fs.mkdirSync(dirAbs, { recursive: true });

  const baseName = sanitizeBaseName(title);
  let downloaded = 0;
  const failures = [];

  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const { buf, ext } = await downloadImageBytes(url);
      const filename = pickAvailableFilename(dirAbs, baseName, i, images.length, ext);
      fs.writeFileSync(path.join(dirAbs, filename), buf);
      downloaded += 1;
    } catch (err) {
      failures.push({ url, error: err.message });
      console.warn(`[eagle-images] 下載圖片失敗，略過：${url}（${err.message}）`);
    }
  }

  if (downloaded === 0) {
    return { attempted: true, downloaded: 0, failed: failures.length, pushed: false, error: "所有圖片都下載失敗" };
  }

  const gitResult = await eagleImagesGit.commitAndPush(`新增圖片：${title}（${folder}）`);

  return {
    attempted: true,
    downloaded,
    failed: failures.length,
    pushed: !!gitResult.pushed,
    skipped: !!gitResult.skipped,
    error: gitResult.error || null,
  };
}
