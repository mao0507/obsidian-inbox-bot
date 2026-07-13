import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.js";
import { processIncomingContent } from "./pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  // 純粹消除瀏覽器自動要 favicon 造成的 404 雜訊，沒有其他作用。
  app.get("/favicon.ico", (req, res) => res.status(204).end());

  app.post("/api/submit", async (req, res) => {
    try {
      const { content } = req.body || {};
      const { draft, result, gitResult, eagleResult, eagleGitResult, embedResult } = await processIncomingContent(
        content,
        "web"
      );
      res.json({
        ok: true,
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
        eagle: eagleResult?.attempted
          ? { synced: !!eagleResult.synced, count: eagleResult.count || 0, error: eagleResult.error || null }
          : null,
        eagleGit: eagleGitResult?.attempted
          ? {
              pushed: !!eagleGitResult.pushed,
              skipped: !!eagleGitResult.skipped,
              downloaded: eagleGitResult.downloaded || 0,
              failed: eagleGitResult.failed || 0,
              error: eagleGitResult.error || null,
            }
          : null,
        embed:
          embedResult && ((embedResult.filenames && embedResult.filenames.length > 0) || embedResult.failed)
            ? {
                count: embedResult.filenames?.length || 0,
                failed: embedResult.failed || 0,
              }
            : null,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.listen(PORT, () => {
    console.log(`[web] 打開 http://localhost:${PORT} 開始丟內容`);
  });
}
