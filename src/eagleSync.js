import { EAGLE_ENABLED, EAGLE_BASE_URL } from "./config.js";

const TIMEOUT_MS = 8000; // Eagle 是本機 app，正常幾百 ms 內就會回應；逾時代表沒開/沒反應

async function eagleFetch(pathname, options = {}) {
  let res;
  try {
    res = await fetch(`${EAGLE_BASE_URL}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`連不到 Eagle（${EAGLE_BASE_URL}），確認 Eagle App 有沒有開著：${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.status !== "success") {
    throw new Error(`Eagle API ${pathname} 回傳失敗：${data?.status || res.status}`);
  }
  return data;
}

function postJson(pathname, body) {
  return eagleFetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Eagle 資料夾樹快取，同一次程式執行期間共用，避免每篇筆記都整棵樹重新掃一次。
// 新建資料夾時會同步更新快取，所以同一批次處理多篇筆記時不會重複建立同名資料夾。
let folderTreeCache = null;

async function getFolderTree(forceRefresh = false) {
  if (folderTreeCache && !forceRefresh) return folderTreeCache;
  const { data } = await eagleFetch("/api/folder/list");
  folderTreeCache = data || [];
  return folderTreeCache;
}

function findChildByName(nodes, name) {
  return (nodes || []).find((n) => n.name === name);
}

// 依照 Obsidian 的 folder 路徑（例如 "07 旅遊/日本/北海道"）在 Eagle 裡確保存在同樣的巢狀資料夾結構，
// 沒有的話沿路建立，回傳最深層那個資料夾的 id。
async function ensureFolderPath(folderPath) {
  const segments = folderPath.split("/").filter(Boolean);
  let nodes = await getFolderTree();
  let parentId = null;
  let currentId = null;

  for (const segment of segments) {
    let match = findChildByName(nodes, segment);
    if (!match) {
      const body = { folderName: segment };
      if (parentId) body.parent = parentId;
      const created = await postJson("/api/folder/create", body);
      match = { ...created.data, children: created.data.children || [] };
      nodes.push(match);
    }
    currentId = match.id;
    parentId = match.id;
    nodes = match.children || [];
  }

  return currentId;
}

/**
 * 把一篇筆記裡抓到的圖片網址匯入 Eagle：
 * 1. 健康檢查 Eagle 有沒有在跑
 * 2. 依 Obsidian 的分類路徑，在 Eagle 裡確保同樣的巢狀資料夾存在
 * 3. 用 addFromURLs 把圖片交給 Eagle 自己下載（本機 API 沒有上傳端點，只能給網址）
 * 4. 用 item/list 撈剛匯入的項目 id，組成 eagle://item/<id> 深連結回傳給呼叫端
 *    （用來寫回 Obsidian 筆記裡，讓筆記可以直接點回 Eagle 裡的圖）
 *
 * 沒啟用 EAGLE_ENABLED、或這篇筆記根本沒有圖片時直接跳過（attempted:false）。
 * Eagle 沒開、或任何一步失敗，都只回傳錯誤訊息，不會丟出例外——
 * 筆記本身一定會正常寫進 vault，圖片同步失敗不影響這件事。
 */
export async function syncImagesToEagle({ images, folder, title, tags, sourceUrl }) {
  if (!EAGLE_ENABLED) return { attempted: false };
  if (!images || images.length === 0) return { attempted: false };

  try {
    await eagleFetch("/api/application/info");

    const folderId = await ensureFolderPath(folder);

    const items = images.map((url, i) => ({
      url,
      name: images.length > 1 ? `${title} - ${i + 1}` : title,
      website: sourceUrl || undefined,
      tags: tags || [],
    }));

    await postJson("/api/item/addFromURLs", { items, folderId });

    // 盡力而為：撈這個資料夾裡最新的幾筆，當作剛剛匯入的項目（個人單機使用情境下這個假設沒問題，
    // 極端情況——同時間手動在 Eagle 裡也匯入東西到同一資料夾——才可能對不上，影響也只是連結沒對準）。
    let links = [];
    try {
      const { data: recentItems } = await eagleFetch(
        `/api/item/list?folders=${encodeURIComponent(folderId)}&limit=${items.length}&orderBy=-CREATEDATE`
      );
      links = (recentItems || []).map((item) => `eagle://item/${item.id}`);
    } catch (err) {
      console.warn(`[eagle-sync] 圖片已匯入，但撈取項目 id 失敗，筆記裡不會附深連結：${err.message}`);
    }

    return { attempted: true, synced: true, count: images.length, links, folderId };
  } catch (err) {
    console.error(`[eagle-sync] 同步圖片到 Eagle 失敗（筆記已正常寫入，只是圖片沒存進 Eagle）：${err.message}`);
    return { attempted: true, synced: false, error: err.message };
  }
}
