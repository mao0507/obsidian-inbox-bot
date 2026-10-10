import { normalizeUrl } from "./duplicateCheck.js";
import { regenerateMoc } from "./mocSync.js";
import { TAXONOMY } from "./taxonomy.js";
import { notebookIdOf } from "./researchPlan.js";

// 舊筆記重建：把改版前的筆記（frontmatter 沒有 type 欄位）用新流程重新產生——重新抓原文、新的精讀模板、
// 新分類樹、新檔名——再把全 vault 的 [[連結]] 改指向新筆記、刪掉舊筆記。
//
// 分三步，讓使用者每一步都能檢查：
//   plan()      dry-run：盤點、同網址分組、測試抓不抓得到原文，寫出 _系統/migration-plan.md，不改任何筆記
//   rebuild()   產生新筆記（可用 limit 先試跑幾組）；舊筆記保留；進度存在 _系統/migration-state.json，可中斷續跑
//   finalize()  改寫連結 → 刪除舊筆記 → 重新產生分類地圖
// 研究筆記（NotebookLM）走另一套重建流程（沿用原本的 notebook），不在這裡處理。
// 打 git tag、最後 commit 由呼叫端（scripts/migrate-vault.js）負責。

const STATE_PATH = "_系統/migration-state.json";
const PLAN_PATH = "_系統/migration-plan.md";
const REPORT_PATH = "_系統/migration-report.md";
const RESEARCH_PLAN_PATH = "_系統/migration-research-plan.md";

const isOldFormat = (note) => !note.frontmatter?.type; // 新筆記、卡片、地圖都有 type
const isResearch = (note) => /^(telegram-notebook|claude-code-skill)$/.test(note.frontmatter?.via || "");
const isSystem = (note) => note.path.startsWith("_系統/") || note.path.startsWith("卡片/");
const withoutExt = (relPath) => relPath.replace(/\.md$/i, "");
const basenameOf = (relPath) => withoutExt(relPath).slice(withoutExt(relPath).lastIndexOf("/") + 1);
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

// [[目標#標題|別名]]
const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

// 每組之間停一下：連續請求同一個網站（例如十幾篇 Notion 頁面）會被限流（HTTP 429）。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMigration({ vault, pipeline, fetcher, pauseMs = 3000 }) {
  function loadState() {
    const raw = vault.readFile(STATE_PATH);
    return raw ? JSON.parse(raw) : { done: {}, failed: {} };
  }
  const saveState = (state) => vault.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  /** 要重建的舊筆記，依來源網址（正規化後）分組；沒有網址的各自一組。組 id = 組內第一個舊路徑。 */
  function inventory() {
    const notes = vault
      .listNotes()
      .filter((n) => !isSystem(n) && isOldFormat(n) && !isResearch(n))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    const groups = [];
    const byUrl = new Map();
    for (const note of notes) {
      const keys = note.sources.map(normalizeUrl).filter(Boolean);
      let group = keys.map((k) => byUrl.get(k)).find(Boolean);
      if (!group) {
        group = { notes: [] };
        groups.push(group);
      }
      group.notes.push(note);
      keys.forEach((k) => byUrl.set(k, group));
    }
    return groups
      .map(({ notes: members }) => {
        const oldPaths = members.map((n) => n.path).sort();
        return { id: oldPaths[0], oldPaths, urls: [...new Set(members.flatMap((n) => n.sources))], title: members[0].title };
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  function writeReport(state) {
    const rows = Object.values(state.done).map(
      (d) => `| ${cell(d.oldPaths.join("<br>"))} | ${cell(d.newPath)} | ${cell(d.folder)} | ${cell(d.tags.join(" "))} | ${d.fetchOk ? "✅" : "⚠️ 用原筆記內容"} |`
    );
    const failed = Object.entries(state.failed).map(([id, error]) => `| ${cell(id)} | ❌ ${cell(error)} | | | |`);
    vault.writeFile(
      REPORT_PATH,
      [
        "# 舊筆記重建結果",
        "",
        "| 舊筆記 | 新筆記 | 分類 | tags | 原文 |",
        "|---|---|---|---|---|",
        ...rows,
        ...failed,
        "",
      ].join("\n")
    );
  }

  return {
    inventory,

    /** dry-run：寫出重建計畫（含原文能不能抓到），不改任何筆記。 */
    async plan() {
      const groups = inventory();
      const rows = [];
      for (const group of groups) {
        let fetchStatus = "—";
        if (group.urls.length) {
          // eslint-disable-next-line no-await-in-loop
          const result = await fetcher.fetch(group.urls[0]);
          // eslint-disable-next-line no-await-in-loop
          await sleep(pauseMs);
          fetchStatus = result.ok ? "✅" : `❌ ${result.error}`;
        }
        const method = group.urls.length && fetchStatus === "✅" ? "重新抓取原文" : "用原筆記內容";
        const merge = group.oldPaths.length > 1 ? `（合併 ${group.oldPaths.length} 篇）` : "";
        rows.push(`| ${cell(group.oldPaths.join("<br>"))} | ${cell(group.urls.join(" "))} | ${cell(fetchStatus)} | ${method}${merge} |`);
      }
      vault.writeFile(
        PLAN_PATH,
        [
          "# 舊筆記重建計畫（dry-run）",
          "",
          `共 ${groups.length} 組、${groups.reduce((n, g) => n + g.oldPaths.length, 0)} 篇舊筆記。新路徑與分類要等重建時由 AI 決定，結果見 migration-report.md。`,
          "",
          "| 舊筆記 | 來源 | 原文 | 重建方式 |",
          "|---|---|---|---|",
          ...rows,
          "",
        ].join("\n")
      );
      return groups;
    },

    /**
     * 重建還沒做過的組（limit 給了就只做前幾組，用來試跑）。舊筆記保留到 finalize。
     * 每組做完就存進度；單組失敗記下來繼續做下一組。
     * @param {{ limit?: number, onProgress?: (msg: string) => void }} [options]
     */
    async rebuild({ limit = Infinity, onProgress } = {}) {
      const state = loadState();
      const pending = inventory().filter((g) => !state.done[g.id]);
      for (const [i, group] of pending.slice(0, limit).entries()) {
        onProgress?.(`(${i + 1}/${Math.min(limit, pending.length)}) ${group.oldPaths.join("、")}`);
        try {
          const notes = group.oldPaths.map((p) => vault.readNote(p));
          // eslint-disable-next-line no-await-in-loop
          const out = await pipeline.rebuildNote(notes);
          state.done[group.id] = {
            oldPaths: group.oldPaths,
            newPath: out.result.relativePath,
            folder: out.draft.folder,
            tags: out.draft.tags,
            fetchOk: group.urls.length > 0 && out.fetchErrors.length < group.urls.length,
          };
          delete state.failed[group.id];
        } catch (err) {
          state.failed[group.id] = err.message;
          onProgress?.(`  ❌ ${err.message}`);
        }
        saveState(state);
        // eslint-disable-next-line no-await-in-loop
        await sleep(pauseMs);
      }
      writeReport(state);
      return state;
    },

    /**
     * 研究筆記（NotebookLM）的重建計畫：請 AI 把同主題的研究分組、每組附研究計畫，
     * 存進進度檔（之後 rebuildResearch 照這份分組做），並寫出 _系統/migration-research-plan.md。不改任何筆記。
     */
    async planResearch() {
      const notes = vault.listNotes().filter((n) => !isSystem(n) && isOldFormat(n) && isResearch(n));
      const groups = await pipeline.groupResearchNotes(notes);
      const state = loadState();
      state.researchGroups = groups;
      saveState(state);

      const notebookIds = (paths) => paths.map((p) => notebookIdOf(notes.find((n) => n.path === p)) || "？（找不到）");
      vault.writeFile(
        RESEARCH_PLAN_PATH,
        [
          "# 研究筆記重建計畫（dry-run）",
          "",
          `共 ${notes.length} 篇研究筆記，分成 ${groups.length} 組。每組會沿用原本的 NotebookLM notebook（多個就合併到來源最多的那個），依研究計畫補跑 deep research 並產生新報告。`,
          "",
          "| 舊筆記 | notebook id | 研究問題 | 研究角度 |",
          "|---|---|---|---|",
          ...groups.map(
            (g) =>
              `| ${cell(g.oldPaths.join("<br>"))} | ${cell(notebookIds(g.oldPaths).join("<br>"))} | ${cell(g.question)} | ${cell(
                g.angles.join("；") || "（由 NotebookLM 自行歸納）"
              )} |`
          ),
          "",
        ].join("\n")
      );
      return groups;
    },

    /**
     * 依 planResearch 的分組重建研究筆記（limit 用來試跑）。舊筆記保留到 finalize；進度與一般筆記共用。
     * @param {{ limit?: number, onProgress?: (msg: string) => void }} [options]
     */
    async rebuildResearch({ limit = Infinity, onProgress } = {}) {
      if (!loadState().researchGroups) await this.planResearch();
      const state = loadState();
      const pending = state.researchGroups.filter((g) => !state.done[g.oldPaths[0]]);
      for (const [i, group] of pending.slice(0, limit).entries()) {
        const id = group.oldPaths[0];
        onProgress?.(`(${i + 1}/${Math.min(limit, pending.length)}) ${group.question}（${group.oldPaths.length} 篇）`);
        try {
          const notes = group.oldPaths.map((p) => vault.readNote(p));
          // eslint-disable-next-line no-await-in-loop
          const out = await pipeline.rebuildResearchNote(notes, { question: group.question, angles: group.angles });
          state.done[id] = {
            oldPaths: group.oldPaths,
            newPath: out.result.relativePath,
            folder: out.draft.folder,
            tags: out.draft.tags,
            fetchOk: true,
          };
          delete state.failed[id];
        } catch (err) {
          state.failed[id] = err.message;
          onProgress?.(`  ❌ ${err.message}`);
        }
        saveState(state);
        // eslint-disable-next-line no-await-in-loop
        await sleep(pauseMs);
      }
      writeReport(state);
      return state;
    },

    /** 改寫全 vault 指向舊筆記的連結、刪除已重建的舊筆記、重新產生所有分類地圖。 */
    async finalize() {
      const state = loadState();
      const byPath = new Map();
      const byName = new Map(); // 舊檔名 -> 新路徑；檔名重複的不收（無法判斷連到哪一篇）
      const ambiguous = new Set();
      for (const { oldPaths, newPath } of Object.values(state.done)) {
        for (const oldPath of oldPaths) {
          byPath.set(withoutExt(oldPath), newPath);
          const name = basenameOf(oldPath);
          if (byName.has(name) && byName.get(name) !== newPath) ambiguous.add(name);
          byName.set(name, newPath);
        }
      }
      ambiguous.forEach((name) => byName.delete(name));

      const rewrite = (content) =>
        content.replace(WIKILINK, (link, target, heading = "", alias) => {
          const key = withoutExt(target.trim());
          const newPath = byPath.get(key) || (!key.includes("/") && byName.get(key));
          if (!newPath) return link;
          return `[[${withoutExt(newPath)}${heading}|${alias ?? basenameOf(newPath)}]]`;
        });

      const oldPaths = new Set(Object.values(state.done).flatMap((d) => d.oldPaths));
      for (const note of vault.listNotes()) {
        if (!oldPaths.has(note.path)) vault.updateNote(note.path, rewrite);
      }
      for (const oldPath of oldPaths) vault.deleteFile(oldPath);
      for (const top of Object.keys(TAXONOMY)) regenerateMoc(vault, top);

      state.finalizedAt = new Date().toISOString();
      saveState(state);
      writeReport(state);
      return state;
    },
  };
}
