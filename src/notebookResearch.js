import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOTEBOOKLM_COMMAND, NOTEBOOKLM_RESEARCH_MODE, NOTEBOOKLM_ENABLED, NOTEBOOKLM_LOGIN_BROWSER } from "./config.js";
import { tryExtractJsonObject } from "./cliRunner.js";
import { askAi } from "./askAi.js";

// Deep Research 官方預設 timeout 是 1800 秒（--mode deep --import-all 這種阻塞式呼叫），
// fast 模式通常幾十秒就完成，但還是給足夠寬裕的上限避免誤殺正常執行中的研究。
const RESEARCH_TIMEOUT_MS = 30 * 60 * 1000;
// generate report --wait 官方預設 timeout 是 300 秒，這裡抓寬一點。
const REPORT_TIMEOUT_MS = 6 * 60 * 1000;
const SHORT_TIMEOUT_MS = 60_000;

// notebooklm 的登入是瀏覽器 cookie，「完全過期」之後一定要開真的瀏覽器重新走一次
// Google 登入流程——這一步沒辦法從背景執行的 bot 自動完成，是 Google 帳號安全機制的
// 限制，不是這支程式能繞過的。能自動做的只有兩件事：
// 1. 定期呼叫 notebooklm auth refresh 幫 session 保活，盡量不要走到完全過期那一步
//    （見下面 startAuthKeepalive）。
// 2. 真的遇到過期錯誤時，先自動試一次 refresh + 重試整個研究流程一次，
//    refresh 對「還沒完全過期、只是快過期」的情況有機會救回來；
//    如果連 refresh 都沒用（代表是真的完全過期），才把下面這句清楚的中文訊息丟出去，
//    請使用者自己跑一次 notebooklm login。
const AUTH_EXPIRED_MESSAGE =
  "NotebookLM 登入已過期，請在這台電腦的終端機執行「notebooklm login」重新登入 Google 帳號，再重試一次 /notebook。";

function isAuthExpiredError(err) {
  return err instanceof Error && err.message === AUTH_EXPIRED_MESSAGE;
}

// 執行 notebooklm CLI 單一指令（指令本身用參數帶，不像 cliRunner.js 的 runCli 是把長內容從 stdin 餵進去），
// 每個 notebooklm 子指令耗時差異很大（create 幾秒、deep research 可能到 30 分鐘），所以逾時時間可個別指定。
function runNotebookLm(args, { timeoutMs = SHORT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NOTEBOOKLM_COMMAND, args, { stdio: ["ignore", "pipe", "pipe"] });
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
          `無法執行 "${NOTEBOOKLM_COMMAND}"：${err.message}` +
            `（確認是否已 uv tool install "notebooklm-py[browser]" 並且在 PATH 上、且跑過 notebooklm login）`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const raw = stderr.slice(0, 500) || stdout.slice(0, 500) || "(無錯誤訊息)";
        // NotebookLM 的登入 cookie 會過期（尤其一段時間沒用），這是目前遇過最常見的失敗原因，
        // 給一句清楚的中文指示，不要讓使用者（尤其在 Telegram 上）看到一整包原始 JSON 錯誤。
        if (/authentication expired|re-authenticate|notebooklm login/i.test(raw)) {
          reject(new Error(AUTH_EXPIRED_MESSAGE));
          return;
        }
        // NotebookLM 伺服器端偶爾會把正在產生中的 artifact 直接下架（通常是 Google 那邊
        // 的速率限制/每日額度用完，或暫時性 API 問題），不是我們的程式或指令下錯，
        // 給一句好懂的中文說明，並提示這通常晚點重試就會好，不用去改設定或程式碼。
        if (/artifact was removed|disappeared from list|quota/i.test(raw)) {
          reject(
            new Error(
              "NotebookLM 這次產生失敗了（伺服器把產生中的內容下架，通常是暫時觸碰到 Google 那邊的速率限制或每日額度），" +
                "不是設定或程式的問題，過一段時間（例如幾分鐘到隔天）重試一次通常就會恢復。"
            )
          );
          return;
        }
        reject(new Error(`notebooklm ${args.join(" ")} 結束代碼 ${code}：${raw}`));
        return;
      }
      resolve(stdout);
    });
  });
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

// 從一段文字裡抓出所有網址（可能出現在句子中間，不是整段文字本身就是網址）。
// 例如使用者傳「幫我研究這部影片 https://youtube.com/... 裡面提到的重點」，
// 這裡要抓出中間那個 URL，而不是只認「整段輸入剛好就是一個網址」這種情況。
// 尾端常見標點（中英文句號、逗號、括號、引號等）如果緊黏在網址後面，會被
// \S+ 一起吃進去，所以額外清掉這些常見的尾端標點。
function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s]+/gi) || [];
  return matches.map((u) => u.replace(/[)\]}>,.;:!?，。；：、」』"'"]+$/, ""));
}

// 主題是網址時，光把網址本身當成後續網路研究/報告提示的查詢字串沒有意義
// （網址不是關鍵字，搜尋引擎/報告生成沒辦法從一串 URL 判斷「這是在講什麼」）。
// 這裡先針對剛加進去的來源本身發問，請它一句話講出實際主題，換成這個描述再繼續，
// 讓後面的網路研究、報告提示都是「針對內容本身」而不是「針對一個網址字串」。
async function describeSource(notebookId, sourceId) {
  try {
    const raw = await runNotebookLm(
      [
        "ask",
        "請用一句話（15~25個中文字）具體描述這個來源實際在講什麼主題或內容重點，直接給關鍵字組成的描述，不要加「這個來源」「本文」之類的贅字，也不要標點符號以外的說明文字。",
        "-s",
        sourceId,
        "-n",
        notebookId,
        "--json",
      ],
      { timeoutMs: SHORT_TIMEOUT_MS }
    );
    const parsed = parseJsonOutput(raw, "ask");
    const answer = (parsed.answer || "").trim();
    return answer || null;
  } catch (err) {
    console.warn(`[notebooklm] 讀取來源主題描述失敗（不影響後續流程，會改用原始輸入繼續）：${err.message}`);
    return null;
  }
}

// 把一個網址加進 notebook 當作保證會被納入的來源，並等它處理完（影片要抓字幕/
// 逐字稿需要一點時間）。成功回傳 sourceId，任何一步失敗都回傳 null、只印警告，
// 不中斷整個研究流程——至少不會比「完全不加、只靠網路研究碰運氣」更差。
async function addUrlSource(notebookId, url) {
  try {
    const addRaw = await runNotebookLm(["source", "add", url, "-n", notebookId, "--json"], {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    const addResult = parseJsonOutput(addRaw, "source add");
    const sourceId = addResult.source?.id || addResult.source_id || addResult.id;
    if (!sourceId) return null;

    const waited = await runNotebookLm(["source", "wait", sourceId, "-n", notebookId, "--timeout", "180"], {
      timeoutMs: 190_000,
    })
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

// 短指令：搭配把使用者原始輸入從 stdin 餵進去的 askAi() CLI 模式一起用，
// 跟 promptBuilder.js 的 CLI_SHORT_INSTRUCTION 同一套慣用法。
const BRIEF_CLI_INSTRUCTION =
  "請根據上面由標準輸入提供的使用者原始需求，摘要成一段適合交給網路研究工具的清楚說明文字，只回傳摘要本身，不要前言或結語、不要條列、不要加引號。";

function buildBriefPrompt(rawInput) {
  return `使用者想請 NotebookLM（一個網路研究工具）針對以下需求做研究，原始輸入可能很簡短、模糊、或只是隨手打的關鍵字：

使用者原始輸入：
${rawInput}

請摘要成一段 2~4 句話的清楚研究說明，把使用者可能想了解的重點角度講清楚、方便直接拿去下網路搜尋做研究。只回傳摘要文字本身，不要前言或結語，用繁體中文。`;
}

// 非網址的主題（使用者打的一般文字需求）：先透過本機 Claude Code CLI（或 API，
// 依 CLASSIFIER_MODE 而定，跟其他功能共用同一套授權）理解使用者實際想研究什麼，
// 摘要成一段清楚的研究說明，取代可能很簡短/模糊的原始輸入，讓 notebook 標題、
// 網路研究查詢字串、報告提示都用這份摘要去跑。
//
// 網址主題不會呼叫這支——網址本身沒有內容可以摘要，硬要 Claude 憑一個 URL 字面
// 猜主題只會是亂猜；網址的「理解內容」交給 describeSource() 用 notebooklm 自己
// 讀真正的來源內容來做，更準確也更誠實（見 runResearchFlow 裡的分流）。
async function summarizeResearchBrief(rawInput) {
  try {
    const brief = await askAi(buildBriefPrompt(rawInput), { cliShortInstruction: BRIEF_CLI_INSTRUCTION });
    return brief && brief.trim() ? brief.trim() : null;
  } catch (err) {
    console.warn(`[notebooklm] 用 Claude 摘要研究需求失敗（改用原始輸入繼續）：${err.message}`);
    return null;
  }
}

/**
 * 實際執行研究流程：建立 notebook -> 用 Deep/Fast Research 自動找來源並匯入
 * -> 產生一份 briefing-doc 報告、等它產生完成 -> 下載報告內容。
 *
 * 全程都用 -n <notebookId> 明確指定要操作哪個 notebook，不依賴 `notebooklm use`
 * 設定的全域 active context——如果同時有兩個人透過 Telegram 分別發起 /notebook 研究，
 * 各自的指令序列不會互相干擾對方的 active notebook。
 */
async function runResearchFlow(topic) {
  const embeddedUrls = extractUrls(topic);
  // 「純網址」：整段輸入去掉頭尾空白後就剛好等於抓到的那一個網址，沒有夾雜其他文字
  // （例如使用者就只丟了一個 YouTube 連結）。這跟「一句話裡面提到一個網址」
  // （例如「幫我研究這部影片 https://... 裡面提到的重點，順便...」）要分開處理：
  // 後者除了網址本身要當來源之外，其餘文字也是使用者真正的意圖，不能丟掉。
  const isPureUrl = embeddedUrls.length === 1 && topic.trim() === embeddedUrls[0];

  // effectiveTopic 預設是使用者輸入的原始 topic：
  // - 純網址：不會呼叫 Claude 摘要（網址本身沒有內容可以摘要，硬要 Claude 憑一個
  //   URL 字面猜主題只會是亂猜），而是等下面把來源加進 notebook 之後，讓 notebooklm
  //   自己讀真正的來源內容來理解（describeSource），更準確也更誠實。
  // - 其他情況（純文字，或文字裡夾雜一兩個網址）：先透過本機 Claude Code CLI/API
  //   （summarizeResearchBrief，沿用 CLASSIFIER_MODE）理解使用者整段需求，摘要成
  //   一段清楚的研究說明——原始輸入常常很簡短模糊、或夾雜「順便幫我...」這類
  //   額外交代，直接拿去搜尋/生報告效果有限，摘要過的版本連 notebook 標題都會用。
  let effectiveTopic = topic;
  if (!isPureUrl) {
    const brief = await summarizeResearchBrief(topic);
    if (brief) {
      effectiveTopic = brief;
    }
  }

  const title = toNotebookTitle(effectiveTopic);

  const createRaw = await runNotebookLm(["create", title, "--json"], { timeoutMs: SHORT_TIMEOUT_MS });
  const createResult = parseJsonOutput(createRaw, "create");
  // 觀察到的實際輸出是 { "notebook": { "id": "...", ... } }（沒有 --use 的話）；
  // 保留其他幾種可能形狀（active_notebook_id、頂層 id/notebook_id）當備援，
  // 避免套件之後改版又換了一種包法就整個壞掉。
  const notebookId =
    createResult.notebook?.id || createResult.notebook_id || createResult.id || createResult.active_notebook_id;
  if (!notebookId) {
    throw new Error(`notebooklm create 沒有回傳 notebook id，原始輸出前 300 字：${createRaw.slice(0, 300)}`);
  }

  if (isPureUrl) {
    // 主題本身就是一個網址（最常見是 YouTube 影片連結）：加為保證來源，
    // 並用來源本身的內容換掉 effectiveTopic（見 describeSource 的說明）。
    const sourceId = await addUrlSource(notebookId, embeddedUrls[0]);
    if (sourceId) {
      const description = await describeSource(notebookId, sourceId);
      if (description) {
        effectiveTopic = description;
      }
    }
  } else if (embeddedUrls.length > 0) {
    // 一句話裡夾雜一個或多個網址：把每個都直接加為保證來源，不能只靠底下的網路
    // 研究「剛好搜到、剛好匯入」（那是碰運氣，冷門連結很可能撲空）。這裡不覆蓋
    // effectiveTopic——上面的摘要已經涵蓋使用者的完整意圖，這裡只是確保連結
    // 本身的內容也確實被納入 notebook。
    for (const url of embeddedUrls) {
      // eslint-disable-next-line no-await-in-loop
      await addUrlSource(notebookId, url);
    }
  }

  // 自動研究並把找到的來源匯入這個 notebook（NOTEBOOKLM_RESEARCH_MODE 預設 fast，
  // 想要更完整的研究可以在 .env 設成 deep，代價是明顯更久，見 README）。
  // 主題是網址時，這一步變成「補充」用——上面已經保證原始來源被納入了，這裡改用
  // effectiveTopic（來源內容描述，不是原始網址）去額外找相關佐證資料。
  await runNotebookLm(
    [
      "source",
      "add-research",
      effectiveTopic,
      "--mode",
      NOTEBOOKLM_RESEARCH_MODE,
      "--import-all",
      "--cited-only",
      "-n",
      notebookId,
    ],
    { timeoutMs: RESEARCH_TIMEOUT_MS }
  );

  // 產生一份簡報稿報告，阻塞等它完成（Telegram bot 這邊本來就是非同步處理，
  // 不受一般 HTTP request timeout 限制，直接等沒問題）。同樣用 effectiveTopic
  // 讓報告生成的提示是「針對實際內容主題」而不是一串網址。
  // --retry 3：Google 這邊偶爾會回報暫時性的速率限制／artifact 產生失敗
  // （NotebookLM 內部佇列問題，不是我們的程式碼問題），讓 CLI 自己用指數退避
  // 重試幾次，減少偶發失敗需要使用者自己重跑一次 /notebook 的機會。
  await runNotebookLm(
    [
      "generate",
      "report",
      `針對「${effectiveTopic}」整理研究重點，附上引用來源`,
      "--format",
      "briefing-doc",
      "--wait",
      "--retry",
      "3",
      "-n",
      notebookId,
    ],
    { timeoutMs: REPORT_TIMEOUT_MS }
  );

  // 下載報告到暫存檔讀出內容即可，真正的存檔目的地是 Obsidian vault（見 pipeline.js），
  // 這裡的暫存檔讀完就刪掉。
  const tmpPath = path.join(os.tmpdir(), `notebooklm-report-${notebookId}-${Date.now()}.md`);
  await runNotebookLm(["download", "report", tmpPath, "-n", notebookId, "--force"], { timeoutMs: SHORT_TIMEOUT_MS });

  let reportText;
  try {
    reportText = fs.readFileSync(tmpPath, "utf8");
  } finally {
    fs.rm(tmpPath, { force: true }, () => {});
  }

  if (!reportText.trim()) {
    throw new Error("notebooklm 下載的報告內容是空的");
  }

  return { notebookId, reportText, effectiveTopic };
}

// 兩段式自動修復登入 session，都不需要開互動視窗：
// 1. `auth refresh --quiet`：輕量的 session 保活，只對「還沒完全過期、快過期」
//    的情況有效。
// 2. 如果 (1) 失敗（代表 session 可能已經真的過期），再試
//    `auth refresh --browser-cookies <browser>`：直接重新讀取這台電腦上
//    NOTEBOOKLM_LOGIN_BROWSER（預設 chrome）目前的登入 cookie 來修復帳號路由。
//    這個才是真的能救回「已經過期」的關鍵——前提是那個瀏覽器裡本身還有一個
//    有效的 Google 登入 session（例如你平常用 Chrome 開 Gmail/NotebookLM 網頁版），
//    等於借用你日常瀏覽器登入的狀態，不用另外跳出一個新視窗要你重新輸入帳密。
//    如果連瀏覽器本身都登出了，這步也會失敗，那就真的沒有自動化的辦法，
//    只能請使用者自己手動跑一次 `notebooklm login`。
async function tryAuthRefresh() {
  try {
    await runNotebookLm(["auth", "refresh", "--quiet"], { timeoutMs: SHORT_TIMEOUT_MS });
    return true;
  } catch (err) {
    console.warn(`[notebooklm] auth refresh 失敗，改試著從瀏覽器（${NOTEBOOKLM_LOGIN_BROWSER}）重新讀取登入狀態：${err.message}`);
  }

  if (!NOTEBOOKLM_LOGIN_BROWSER) {
    return false;
  }

  try {
    await runNotebookLm(["auth", "refresh", "--browser-cookies", NOTEBOOKLM_LOGIN_BROWSER], {
      timeoutMs: SHORT_TIMEOUT_MS,
    });
    console.log(`[notebooklm] 已從瀏覽器（${NOTEBOOKLM_LOGIN_BROWSER}）重新讀取登入狀態成功`);
    return true;
  } catch (err) {
    console.warn(
      `[notebooklm] 從瀏覽器（${NOTEBOOKLM_LOGIN_BROWSER}）重新讀取登入狀態也失敗（可能瀏覽器裡也沒有有效的登入 session）：${err.message}`
    );
    return false;
  }
}

// 開瀏覽器走完整的 `notebooklm login` OAuth 流程——這是 tryAuthRefresh() 都救不回來
// （真的完全過期）時最後的自動化手段。會在「跑這個 node 服務的那台機器」上跳出瀏覽器
// 視窗，等使用者在瀏覽器裡完成 Google 登入後，CLI 才會結束、這裡才會 resolve。
// 給 5 分鐘讓使用者有空完成登入，不是一般 CLI 指令的等級，逾時就當作失敗，
// 交回 researchTopic() 用原本的 AUTH_EXPIRED_MESSAGE 提示使用者自己處理。
const FULL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function tryFullLogin() {
  try {
    await runNotebookLm(["login"], { timeoutMs: FULL_LOGIN_TIMEOUT_MS });
    return true;
  } catch (err) {
    console.warn(`[notebooklm] 自動執行 notebooklm login 失敗：${err.message}`);
    return false;
  }
}

/**
 * 用 NotebookLM 針對一個主題做研究，回傳研究報告內容（Markdown 文字）與 notebook id。
 * 遇到登入過期時會依序自動嘗試：
 * 1. notebooklm auth refresh（輕量保活，只救得回「快過期」的情況）
 * 2. 都沒用的話，直接跑一次完整的 notebooklm login（開瀏覽器走 Google 登入，
 *    只適合這個服務本身就跑在使用者自己電腦上的情境——遠端 server 上看不到跳出來的瀏覽器）
 * 每一步成功就重試一次整個研究流程；兩步都失敗才把 AUTH_EXPIRED_MESSAGE 丟出去，
 * 請使用者自己到終端機跑 notebooklm login。
 *
 * onStatus（可選）：每個自動修復步驟開始時呼叫一次，帶一句中文說明，方便呼叫端
 * （例如 bot.js）即時更新 Telegram 訊息，讓使用者知道現在卡在「等自動重新登入」。
 */
export async function researchTopic(topic, { onStatus } = {}) {
  try {
    return await runResearchFlow(topic);
  } catch (err) {
    if (!isAuthExpiredError(err)) {
      throw err;
    }

    console.warn("[notebooklm] 偵測到登入過期，自動嘗試 auth refresh 後重試一次...");
    onStatus?.("🔑 偵測到 NotebookLM 登入過期，嘗試自動 refresh 登入狀態...");
    const refreshed = await tryAuthRefresh();
    if (refreshed) {
      return runResearchFlow(topic);
    }

    console.warn("[notebooklm] auth refresh 沒用，改嘗試完整的 notebooklm login...");
    onStatus?.("🔑 自動 refresh 沒用，正在開瀏覽器重新登入，請到跑這個服務的電腦上完成 Google 登入（最多等 5 分鐘）...");
    const loggedIn = await tryFullLogin();
    if (!loggedIn) {
      throw err;
    }

    onStatus?.("✅ 重新登入成功，重新開始研究任務...");
    return runResearchFlow(topic);
  }
}

// 背景保活：定期呼叫 notebooklm auth refresh，盡量讓登入 session 不要走到完全過期
// （完全過期後需要開瀏覽器重新登入，沒辦法從這支背景程式自動完成）。
// 只要 NOTEBOOKLM_ENABLED（偵測到 notebooklm CLI）才會啟動；失敗只印警告，
// 不影響 bot 其他功能——真的過期的話，researchTopic() 上面那層重試機制、
// 以及最後 /notebook 指令的錯誤訊息都還是會照原本邏輯運作。
export function startAuthKeepalive({ intervalMs = 12 * 60 * 60 * 1000 } = {}) {
  if (!NOTEBOOKLM_ENABLED) return;

  const refresh = async () => {
    const ok = await tryAuthRefresh();
    if (ok) {
      console.log("[notebooklm] 已自動 refresh 登入 session 保活");
    }
  };

  refresh();
  setInterval(refresh, intervalMs);
}
