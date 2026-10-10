import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryExtractJsonObject } from "./cliRunner.js";
import { findUrls } from "./extractContent.js";

// NotebookLM Research module。interface：
//   researchTopic(topic, { onStatus }) -> { notebookId, reportText, effectiveTopic }
//   login()                            -> CLI 輸出文字（給 /notebooklm_login 用）
//   startAuthKeepalive()
// 背後的 notebooklm CLI 是一個 seam：正式環境用 createNotebookLmRunner()（真的 spawn），
// 測試傳一個照劇本回應的假 run 進來，URL 分流、登入過期自動修復這些分支不用連網路就能驗證。
// 這支不 import config.js，接線在 app.js。

// Deep Research 官方預設 timeout 是 1800 秒（--mode deep --import-all 這種阻塞式呼叫），
// fast 模式通常幾十秒就完成，但還是給足夠寬裕的上限避免誤殺正常執行中的研究。
const RESEARCH_TIMEOUT_MS = 30 * 60 * 1000;
// generate report --wait 官方預設 timeout 是 300 秒，這裡抓寬一點。
const REPORT_TIMEOUT_MS = 6 * 60 * 1000;
const SHORT_TIMEOUT_MS = 60_000;
// 完整 `notebooklm login` 要等使用者在瀏覽器裡完成 Google 登入，給 5 分鐘。
const FULL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// notebooklm 的登入是瀏覽器 cookie，「完全過期」之後一定要開真的瀏覽器重新走一次
// Google 登入流程——這一步沒辦法從背景執行的 bot 自動完成，是 Google 帳號安全機制的
// 限制，不是這支程式能繞過的。能自動做的只有：
// 1. 定期呼叫 notebooklm auth refresh 幫 session 保活（見 startAuthKeepalive）。
// 2. 真的遇到過期錯誤時，先自動試 refresh / 瀏覽器 cookie / 完整 login，再重試整個研究流程一次；
//    都沒用才把這個錯誤丟出去，請使用者自己跑一次 notebooklm login。
export class NotebookAuthExpiredError extends Error {
  constructor() {
    super("NotebookLM 登入已過期，請在這台電腦的終端機執行「notebooklm login」重新登入 Google 帳號，再重試一次 /notebook。");
    this.name = "NotebookAuthExpiredError";
  }
}

/**
 * notebooklm CLI adapter：執行單一子指令（指令本身用參數帶，不像 cliRunner.js 的 runCli 是把長內容從 stdin 餵進去），
 * 回傳 stdout。每個子指令耗時差異很大（create 幾秒、deep research 可能到 30 分鐘），所以逾時時間可個別指定。
 */
export function createNotebookLmRunner(command) {
  return function run(args, { timeoutMs = SHORT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`notebooklm ${args[0] || ""} 逾時（超過 ${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new Error(
            `無法執行 "${command}"：${err.message}` +
              `（確認是否已 uv tool install "notebooklm-py[browser]" 並且在 PATH 上、且跑過 notebooklm login）`
          )
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const raw = stderr.slice(0, 500) || stdout.slice(0, 500) || "(無錯誤訊息)";
        // login 本身失敗時輸出裡也會出現 "notebooklm login" 字樣，不能被當成「登入過期」。
        if (args[0] !== "login") {
          // 登入 cookie 過期是目前遇過最常見的失敗原因，換成清楚的中文指示，不要讓使用者看到一整包原始 JSON 錯誤。
          if (/authentication expired|re-authenticate|notebooklm login/i.test(raw)) {
            reject(new NotebookAuthExpiredError());
            return;
          }
          // NotebookLM 伺服器端偶爾會把正在產生中的 artifact 直接下架（通常是 Google 那邊的速率限制/每日額度），
          // 不是我們的程式或指令下錯，晚點重試通常就會好。
          if (/artifact was removed|disappeared from list|quota/i.test(raw)) {
            reject(
              new Error(
                "NotebookLM 這次產生失敗了（伺服器把產生中的內容下架，通常是暫時觸碰到 Google 那邊的速率限制或每日額度），" +
                  "不是設定或程式的問題，過一段時間（例如幾分鐘到隔天）重試一次通常就會恢復。"
              )
            );
            return;
          }
        }
        reject(new Error(`notebooklm ${args.join(" ")} 結束代碼 ${code}：${stderr.slice(-3000) || stdout.slice(-3000) || raw}`));
      });
    });
  };
}

function parseJsonOutput(raw, label) {
  const parsed = tryExtractJsonObject(raw);
  if (!parsed) {
    throw new Error(`notebooklm ${label} 沒有回傳可解析的 JSON，原始輸出前 300 字：${raw.slice(0, 300)}`);
  }
  return parsed;
}

// Notebook 標題長度抓寬鬆一點就好，避免主題本身太長。
function toNotebookTitle(topic) {
  return topic.length > 100 ? `${topic.slice(0, 97)}...` : topic;
}

const REPORT_LANGUAGE = "zh_Hant";

/** 給 NotebookLM 的報告提示：依研究計畫的每個角度寫一個詳細章節，事實附引用。 */
export function buildReportPrompt({ question, angles = [] }) {
  const outline = angles.length
    ? `請依下列研究角度逐一撰寫獨立章節（每個角度一個 ## 章節，章節標題就是角度名稱）：\n${angles
        .map((angle, i) => `${i + 1}. ${angle}`)
        .join("\n")}`
    : "請自行歸納 4~6 個最重要的面向，每個面向一個 ## 章節。";
  return `請用繁體中文撰寫一份詳細的研究報告。

研究問題：${question}

${outline}

每個章節都要：
- 先寫這個角度的結論，再寫支持結論的具體細節：數據、時間點、案例、做法步驟、正反觀點
- 每個事實都標註引用來源，報告最後列出完整的來源清單
- 寫得完整詳細，不要只列重點或摘要

最後加一節「## 綜合結論與建議」：整合各角度的發現，並指出資料不足或仍有爭議的地方。`;
}

// 短指令：搭配把使用者原始輸入從 stdin 餵進去的 CLI backend 一起用。
const BRIEF_INSTRUCTION =
  "請根據上面由標準輸入提供的使用者原始需求，摘要成一段適合交給網路研究工具的清楚說明文字，只回傳摘要本身，不要前言或結語、不要條列、不要加引號。";

function buildBriefPrompt(rawInput) {
  return `使用者想請 NotebookLM（一個網路研究工具）針對以下需求做研究，原始輸入可能很簡短、模糊、或只是隨手打的關鍵字：

使用者原始輸入：
${rawInput}

請摘要成一段 2~4 句話的清楚研究說明，把使用者可能想了解的重點角度講清楚、方便直接拿去下網路搜尋做研究。只回傳摘要文字本身，不要前言或結語，用繁體中文。`;
}

/**
 * @param {object} deps
 * @param {(args: string[], opts?: {timeoutMs?: number}) => Promise<string>} deps.run  notebooklm CLI adapter
 * @param {{ ask: Function }} deps.ai  aiBackends.js 的任一 adapter，用來把模糊的研究需求摘要清楚
 * @param {"fast"|"deep"} [deps.researchMode]
 * @param {string} [deps.loginBrowser]  auth refresh --browser-cookies 用的瀏覽器，空字串 = 不嘗試
 */
export function createNotebookResearch({ run, ai, researchMode = "deep", loginBrowser = "" }) {
  // 主題是網址時，光把網址本身當成後續網路研究/報告提示的查詢字串沒有意義。
  // 這裡先針對剛加進去的來源本身發問，請它一句話講出實際主題，換成這個描述再繼續。
  async function describeSource(notebookId, sourceId) {
    try {
      const raw = await run([
        "ask",
        "請用一句話（15~25個中文字）具體描述這個來源實際在講什麼主題或內容重點，直接給關鍵字組成的描述，不要加「這個來源」「本文」之類的贅字，也不要標點符號以外的說明文字。",
        "-s",
        sourceId,
        "-n",
        notebookId,
        "--json",
      ]);
      return (parseJsonOutput(raw, "ask").answer || "").trim() || null;
    } catch (err) {
      console.warn(`[notebooklm] 讀取來源主題描述失敗（不影響後續流程，會改用原始輸入繼續）：${err.message}`);
      return null;
    }
  }

  // 把一個網址加進 notebook 當作保證會被納入的來源，並等它處理完（影片要抓字幕/逐字稿需要一點時間）。
  // 成功回傳 sourceId，任何一步失敗都回傳 null、只印警告，不中斷整個研究流程。
  async function addUrlSource(notebookId, url) {
    try {
      const addResult = parseJsonOutput(await run(["source", "add", url, "-n", notebookId, "--json"]), "source add");
      const sourceId = addResult.source?.id || addResult.source_id || addResult.id;
      if (!sourceId) return null;

      const waited = await run(["source", "wait", sourceId, "-n", notebookId, "--timeout", "180"], { timeoutMs: 190_000 })
        .then(() => true)
        .catch((err) => {
          console.warn(`[notebooklm] 等待來源處理完成逾時或失敗（不影響後續流程）：${err.message}`);
          return false;
        });
      return waited ? sourceId : null;
    } catch (err) {
      console.warn(`[notebooklm] 加入來源失敗（${url}），改靠下面的網路研究找相關內容：${err.message}`);
      return null;
    }
  }

  // 非網址的主題：先透過 AI backend 理解使用者實際想研究什麼，摘要成一段清楚的研究說明。
  // 網址主題不會呼叫這支——網址本身沒有內容可以摘要，硬要 AI 憑一個 URL 字面猜主題只會是亂猜，
  // 那種情況交給 describeSource() 讓 notebooklm 讀真正的來源內容。
  async function summarizeResearchBrief(rawInput) {
    try {
      const brief = await ai.ask(buildBriefPrompt(rawInput), { instruction: BRIEF_INSTRUCTION });
      return brief?.trim() || null;
    } catch (err) {
      console.warn(`[notebooklm] 用 AI 摘要研究需求失敗（改用原始輸入繼續）：${err.message}`);
      return null;
    }
  }

  /**
   * 建立 notebook -> 用 Deep/Fast Research 自動找來源並匯入 -> 產生 briefing-doc 報告 -> 下載報告內容。
   * 全程用 -n <notebookId> 明確指定 notebook，不依賴 `notebooklm use` 的全域 active context，
   * 同時有兩個研究在跑也不會互相干擾。
   */
  async function runResearchFlow(topic, plan) {
    const embeddedUrls = findUrls(topic);
    // 「純網址」（整段輸入就是一個網址）跟「一句話裡面提到網址」要分開處理：
    // 後者除了網址本身要當來源之外，其餘文字也是使用者真正的意圖，不能丟掉。
    const isPureUrl = embeddedUrls.length === 1 && topic.trim() === embeddedUrls[0];

    // 有研究計畫（使用者在 Telegram 確認過的）就直接用計畫的研究問題；
    // 沒有計畫（例如命令列腳本）才自己摘要模糊的輸入。
    let effectiveTopic = plan?.question || topic;
    if (!plan && !isPureUrl) {
      effectiveTopic = (await summarizeResearchBrief(topic)) || topic;
    }

    const createRaw = await run(["create", toNotebookTitle(effectiveTopic), "--json"]);
    const createResult = parseJsonOutput(createRaw, "create");
    // 觀察到的實際輸出是 { "notebook": { "id": "..." } }；其他形狀當備援，避免套件改版又換一種包法。
    const notebookId =
      createResult.notebook?.id || createResult.notebook_id || createResult.id || createResult.active_notebook_id;
    if (!notebookId) {
      throw new Error(`notebooklm create 沒有回傳 notebook id，原始輸出前 300 字：${createRaw.slice(0, 300)}`);
    }

    if (isPureUrl) {
      // 主題本身就是一個網址（最常見是 YouTube 影片）：加為保證來源，並用來源本身的內容換掉 effectiveTopic。
      const sourceId = await addUrlSource(notebookId, embeddedUrls[0]);
      if (sourceId && !plan) {
        effectiveTopic = (await describeSource(notebookId, sourceId)) || effectiveTopic;
      }
    } else {
      // 一句話裡夾雜網址：每個都直接加為保證來源，不能只靠網路研究「剛好搜到」。
      for (const url of embeddedUrls) {
        // eslint-disable-next-line no-await-in-loop
        await addUrlSource(notebookId, url);
      }
    }

    const reportText = await deepenAndReport(notebookId, { question: effectiveTopic, angles: plan?.angles || [] });
    return { notebookId, reportText, effectiveTopic };
  }

  /**
   * 在指定 notebook 上補跑一次網路研究（匯入找到的來源），再依研究問題與角度產生一份繁中詳細報告並下載。
   * 新研究與「補充既有研究」都走這裡。
   */
  async function deepenAndReport(notebookId, { question, angles = [] }) {
    await run(
      ["source", "add-research", question, "--mode", researchMode, "--import-all", "--cited-only", "-n", notebookId],
      { timeoutMs: RESEARCH_TIMEOUT_MS }
    );

    // custom 格式才會照我們的大綱寫（briefing-doc 會忽略自訂說明）；--language 只影響這次產生，
    // 不會動到帳號的全域語言設定。提示很長，用 --prompt-file 傳。
    // --retry 3：Google 偶爾回報暫時性速率限制，讓 CLI 自己指數退避重試。
    const stamp = `${notebookId}-${Date.now()}`;
    const promptPath = path.join(os.tmpdir(), `notebooklm-prompt-${stamp}.txt`);
    const reportPath = path.join(os.tmpdir(), `notebooklm-report-${stamp}.md`);
    fs.writeFileSync(promptPath, buildReportPrompt({ question, angles }), "utf8");
    try {
      await run(
        [
          "generate",
          "report",
          "--format",
          "custom",
          "--prompt-file",
          promptPath,
          "--language",
          REPORT_LANGUAGE,
          "--wait",
          "--retry",
          "3",
          "-n",
          notebookId,
        ],
        { timeoutMs: REPORT_TIMEOUT_MS }
      );
      // 下載到暫存檔讀出內容即可，真正的存檔目的地是 Obsidian vault（見 pipeline.js）。
      await run(["download", "report", reportPath, "-n", notebookId, "--force"]);
      const reportText = fs.readFileSync(reportPath, "utf8");
      if (!reportText.trim()) throw new Error("notebooklm 下載的報告內容是空的");
      return reportText;
    } finally {
      fs.rmSync(promptPath, { force: true });
      fs.rmSync(reportPath, { force: true });
    }
  }

  // 兩段式自動修復登入 session，都不需要開互動視窗：
  // 1. `auth refresh --quiet`：輕量保活，只對「快過期」的情況有效。
  // 2. `auth refresh --browser-cookies <browser>`：借用這台電腦上瀏覽器目前的 Google 登入 cookie，
  //    能救回「已經過期」——前提是那個瀏覽器本身還登入著。
  async function tryAuthRefresh() {
    try {
      await run(["auth", "refresh", "--quiet"]);
      return true;
    } catch (err) {
      console.warn(`[notebooklm] auth refresh 失敗，改試著從瀏覽器（${loginBrowser}）重新讀取登入狀態：${err.message}`);
    }
    if (!loginBrowser) return false;

    try {
      await run(["auth", "refresh", "--browser-cookies", loginBrowser]);
      console.log(`[notebooklm] 已從瀏覽器（${loginBrowser}）重新讀取登入狀態成功`);
      return true;
    } catch (err) {
      console.warn(`[notebooklm] 從瀏覽器（${loginBrowser}）重新讀取登入狀態也失敗：${err.message}`);
      return false;
    }
  }

  // 開瀏覽器走完整的 OAuth 流程，會在「跑這個 node 服務的那台機器」上跳出瀏覽器視窗。
  function login() {
    return run(["login"], { timeoutMs: FULL_LOGIN_TIMEOUT_MS });
  }

  /**
   * 執行 task；遇到登入過期時依序自動嘗試 auth refresh、完整 login，每一步成功就重試一次 task，
   * 都失敗才把 NotebookAuthExpiredError 丟出去。
   * onStatus（可選）：每個自動修復步驟開始時呼叫一次，讓呼叫端即時更新 Telegram 訊息。
   */
  async function withAuthRecovery(task, onStatus) {
    try {
      return await task();
    } catch (err) {
      if (!(err instanceof NotebookAuthExpiredError)) throw err;

      console.warn("[notebooklm] 偵測到登入過期，自動嘗試 auth refresh 後重試一次...");
      onStatus?.("🔑 偵測到 NotebookLM 登入過期，嘗試自動 refresh 登入狀態...");
      if (await tryAuthRefresh()) return task();

      console.warn("[notebooklm] auth refresh 沒用，改嘗試完整的 notebooklm login...");
      onStatus?.("🔑 自動 refresh 沒用，正在開瀏覽器重新登入，請到跑這個服務的電腦上完成 Google 登入（最多等 5 分鐘）...");
      try {
        await login();
      } catch (loginErr) {
        console.warn(`[notebooklm] 自動執行 notebooklm login 失敗：${loginErr.message}`);
        throw err;
      }

      onStatus?.("✅ 重新登入成功，重新開始研究任務...");
      return task();
    }
  }

  return {
    login,

    /** 用 NotebookLM 針對一個主題做研究（新 notebook），回傳報告。 */
    researchTopic(topic, { plan, onStatus } = {}) {
      return withAuthRecovery(() => runResearchFlow(topic, plan), onStatus);
    },

    /** 在既有 notebook 上依計畫補跑研究、重新產生報告（補充既有研究用）。 */
    async supplementResearch(notebookId, plan, { onStatus } = {}) {
      const reportText = await withAuthRecovery(() => deepenAndReport(notebookId, plan), onStatus);
      return { notebookId, reportText };
    },

    // 背景保活：定期 auth refresh，盡量讓登入 session 不要走到完全過期。失敗只印警告。
    startAuthKeepalive({ intervalMs = 12 * 60 * 60 * 1000 } = {}) {
      const refresh = async () => {
        if (await tryAuthRefresh()) console.log("[notebooklm] 已自動 refresh 登入 session 保活");
      };
      refresh();
      setInterval(refresh, intervalMs);
    },
  };
}
