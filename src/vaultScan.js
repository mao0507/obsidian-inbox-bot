import fs from "node:fs";
import { vaultFilePath } from "./config.js";
import { DYNAMIC_TAXONOMY } from "./taxonomy.js";

function listDirs(absPath) {
  try {
    return fs
      .readdirSync(absPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// 掃描 vault 裡動態分類（DYNAMIC_TAXONOMY）目前已經建立的資料夾，
// 蒐集每一層「AI 自訂（free）」的既有名稱。目的是讓分類時把這份清單
// 放進 prompt，AI 才會優先重複使用既有名稱，不會每次生一個新變體
// （例如已經有 "ClaudeCode"，就不會再建一個 "Claude Code" 或 "Claude AI"）。
//
// 只有「完整走到規定的階層深度」的路徑才會被視為有效既有名稱，
// 避免舊分類結構留下的殘破空資料夾（例如改版前的 "AI/教學文章"）
// 被誤判成新結構裡的名稱。
export function getDynamicFolderExamples() {
  const lines = [];

  for (const [top, cfg] of Object.entries(DYNAMIC_TAXONOMY)) {
    const freeValuesPerLevel = cfg.levels.map(() => new Set());

    // 回傳這個節點底下是否有任何一條路徑完整走到最深層。
    function walk(relSegments, levelIndex) {
      if (levelIndex === cfg.levels.length) return true;
      const level = cfg.levels[levelIndex];
      const dirs = listDirs(vaultFilePath(top, ...relSegments));
      let foundAny = false;

      if (level.type === "free") {
        for (const d of dirs) {
          if (walk([...relSegments, d], levelIndex + 1)) {
            freeValuesPerLevel[levelIndex].add(d);
            foundAny = true;
          }
        }
      } else {
        for (const option of level.options) {
          if (dirs.includes(option) && walk([...relSegments, option], levelIndex + 1)) {
            foundAny = true;
          }
        }
      }
      return foundAny;
    }

    walk([], 0);

    const parts = cfg.levels
      .map((lv, i) =>
        lv.type === "free" && freeValuesPerLevel[i].size > 0
          ? `${lv.name}已有：${[...freeValuesPerLevel[i]].sort().join("、")}`
          : null
      )
      .filter(Boolean);

    if (parts.length) {
      lines.push(`- ${top}：${parts.join("；")}`);
    }
  }

  return lines.join("\n");
}
