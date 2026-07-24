import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { PORT } from "./config.js";
import { processIncomingContent } from "./pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 找出目前占用某個 port 的 process 並強制關閉，讓 startServer() 可以重新監聽。
// Windows 用 netstat -ano 找 PID + taskkill；macOS/Linux 用 lsof + kill -9。
// 找不到任何東西占用這個 port（或指令本身跑不出結果）時當作「本來就沒有東西占用」，
// 不當成錯誤，讓外層重新監聽自然決定成功還是失敗。
function killProcessOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const output = execSync("netstat -ano", { encoding: "utf8" });
      const portPattern = new RegExp(`:${port}(?!\\d)`);
      for (const line of output.split("\n")) {
        if (!portPattern.test(line) || !/LISTENING/.test(line)) continue;
        const match = line.trim().match(/(\d+)\s*$/);
        if (match) pids.add(match[1]);
      }
      for (const pid of pids) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      }
    } else {
      const output = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" });
      for (const pid of output.split("\n").map((s) => s.trim()).filter(Boolean)) {
        pids.add(pid);
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      }
    }
  } catch {
    // netstat/lsof 在「沒有東西占用這個 port」時通常會回傳非 0 結束碼或空輸出，忽略即可。
  }
  return [...pids];
}

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  // 純粹消除瀏覽器自動要 favicon 造成的 404 雜訊，沒有其他作用。
  app.get("/favicon.ico", (req, res) => res.status(204).end());

  app.post("/api/submit", async (req, res) => {
    try {
      const { content } = req.body || {};
      const { duplicate, duplicatePath, draft, result, gitResult, relatedResult, mocResult } =
        await processIncomingContent(content, "web");

      if (duplicate) {
        res.json({ ok: true, duplicate: true, duplicatePath });
        return;
      }

      res.json({
        ok: true,
        duplicate: false,
        folder: draft.folder,
        filename: path.basename(result.relativePath),
        relativePath: result.relativePath,
        title: draft.title,
        tags: draft.tags,
        summary: draft.summary,
        reasoning: draft.reasoning,
        git: gitResult?.attempted
          ? { pushed: !!gitResult.pushed, skipped: !!gitResult.skipped, error: gitResult.error || null }
          : null,
        related: relatedResult?.linkedCount ? { linkedCount: relatedResult.linkedCount } : null,
        moc: mocResult?.updated ? { path: mocResult.mocPath } : null,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // 監聽 PORT；如果啟動時發現這個 port 已經被占用（EADDRINUSE，最常見的情況是
  // 前一次沒關乾淨的 npm start / npm run dev 還在跑），自動找出並強制關閉占用它的
  // process，重試一次監聽。重試後還是失敗才真的當成錯誤放棄。
  function listen(isRetry = false) {
    const httpServer = app.listen(PORT, () => {
      console.log(`[web] 打開 http://localhost:${PORT} 開始丟內容`);
    });

    httpServer.on("error", (err) => {
      if (err.code !== "EADDRINUSE") {
        console.error(`[web] 啟動失敗：${err.message}`);
        process.exit(1);
      }

      if (isRetry) {
        console.error(
          `[web] ❌ Port ${PORT} 清除後還是無法監聽，請手動確認是什麼程式在占用這個 port` +
            `（Windows: netstat -ano | findstr :${PORT}；macOS/Linux: lsof -i :${PORT}）。`
        );
        process.exit(1);
      }

      console.warn(`[web] ⚠️ Port ${PORT} 已經被占用，嘗試清除占用它的程式...`);
      const killedPids = killProcessOnPort(PORT);
      if (killedPids.length) {
        console.warn(`[web] 已強制關閉占用 port ${PORT} 的程式（PID: ${killedPids.join(", ")}），重新監聽...`);
      } else {
        console.warn(`[web] 沒找到明確占用 port ${PORT} 的程式，直接重試監聽一次...`);
      }

      // 給作業系統一點時間真正釋放 port，馬上重試偶爾還是會撞到同一個 EADDRINUSE。
      setTimeout(() => listen(true), 500);
    });
  }

  listen();
}
