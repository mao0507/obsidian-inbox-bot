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

  app.listen(PORT, () => {
    console.log(`[web] 打開 http://localhost:${PORT} 開始丟內容`);
  });
}
