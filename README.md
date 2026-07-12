# Obsidian Inbox Bot

丟內容（文字、想法、網址）進來，Claude 會自動分類、補充說明、寫成筆記存進你的 Obsidian vault。支援兩種入口：網頁表單、Telegram bot，共用同一套分類邏輯。

跑在你自己的電腦上，需要保持這個程式在背景執行（開著終端機視窗，或設成開機啟動的背景服務）才能持續接收內容。

## 需要準備的東西

1. **Node.js 18 以上**：<https://nodejs.org> 下載 LTS 版安裝。安裝完在終端機打 `node -v` 確認。
2. **分類用的 AI，二選一**：
   - **本機已裝的 agent CLI（預設、推薦）**：Claude Code CLI（`claude`）或 Cursor CLI（`cursor-agent`）擇一裝好、登入過就行，什麼都不用多做——程式啟動時會自動偵測到，直接用它做分類，不用另外申請/付費 API key。兩個都裝的話預設優先用 `claude`。
   - **Anthropic API key**：兩個 CLI 都沒裝的話，去 <https://console.anthropic.com/settings/keys> 申請一把，用量計費，分類/整理一篇內容通常幾分錢台幣等級的費用。
3. **（要用 Telegram bot 的話）Telegram bot token**：
   - Telegram 搜尋 `@BotFather` → 傳 `/newbot` → 照指示取名 → 拿到一組 `123456:ABC-xxxxxxxx` 格式的 token。
   - 之後在 Telegram 找到你剛建立的 bot，按「開始」或傳 `/start` 給它，才能開始跟它聊天。
4. **（要丟 Notion 頁面連結的話）Playwright 瀏覽器核心**：`npm install` 之後多跑一次 `npx playwright install chromium`（見下面「安裝步驟」）。不丟 Notion 連結的話可以跳過，其他網址不受影響。

## 安裝步驟

1. 打開終端機，切到這個資料夾：
   ```bash
   cd obsidian-inbox-bot
   npm install
   ```
   如果會丟 Notion 頁面連結進來，再多跑一次（下載 Chromium，約幾百 MB，只需跑一次）：
   ```bash
   npx playwright install chromium
   ```
2. 複製設定檔並填入你的資訊：
   ```bash
   cp .env.example .env
   ```
   用文字編輯器打開 `.env`，至少要填：
   - `VAULT_PATH`：你的 Obsidian vault 資料夾**完整路徑**，例如 `C:\Users\User\Documents\Obsidian Vault`
   - `TELEGRAM_BOT_TOKEN`：剛申請的 bot token（不想用 Telegram 就留空，程式會自動跳過）

   分類用的 AI 預設會自動偵測（`CLASSIFIER_MODE=auto`）：電腦上找得到 `claude` 指令就直接用，不用填 `ANTHROPIC_API_KEY`。
   找不到的話會退回 API key 模式，這時才需要填 `ANTHROPIC_API_KEY`。想強制指定其中一種，把 `CLASSIFIER_MODE` 改成 `cli` 或 `api` 即可。
3. 啟動：
   ```bash
   npm start
   ```
   看到這樣代表成功：
   ```
   [classifier] 使用本機 agent CLI「claude」做分類，不需要 API key
   [telegram] bot 已啟動（polling 模式）
   [web] 打開 http://localhost:3838 開始丟內容
   ```
   （如果是退回 API key 模式，第一行會改成 `[classifier] 使用 Anthropic API（claude-sonnet-4-5）做分類`）

## 怎麼用

- **網頁**：瀏覽器打開 <http://localhost:3838>，貼上文字或網址，按送出。手機也可以連（前提是手機和電腦在同一個 Wi-Fi，網址要換成電腦的區網 IP，例如 `http://192.168.1.23:3838`）。
- **Telegram**：直接傳訊息或網址給你的 bot，它會回覆分類結果和存檔位置。

分類完成後，直接去 Obsidian 打開對應資料夾，就會看到新筆記（如果 Obsidian 正開著，會自動偵測到新檔案）。

## 分類規則怎麼調整

打開 `src/taxonomy.js`：

- `TAXONOMY`：資料夾樹狀結構，照你目前 vault 的 00 Inbox / 01 Knowledge / 02 Projects / 03 Snippets / 04 Bugs / 05 Learning / Assets 設定好了。要加新技術分類（例如 `01 Knowledge` 底下加 `Python`），直接在陣列裡加一行字串即可，不用改其他程式碼。
- `RULES`：文字描述的分類規則，可以照自己習慣改寫，Claude 會照這份規則判斷。

改完存檔、重新 `npm start` 即可生效。

## 保持背景執行（選用）

不想一直開著終端機視窗的話：

- **Windows**：用工作排程器（Task Scheduler）設一個開機啟動的工作，動作是執行 `node`，參數是 `src\index.js`，起始位置設成這個資料夾。或安裝 [pm2](https://pm2.keymetrics.io/)：`npm install -g pm2` → `pm2 start src/index.js --name obsidian-bot` → `pm2 save`。
- **macOS**：用 `pm2`，或寫一個 `launchd` plist 開機啟動。

## 用本機 agent CLI 做分類（不用 API key）

預設（`CLASSIFIER_MODE=auto`）啟動時會依序偵測電腦上裝了下面哪一個，用找到的第一個：

1. **Claude Code CLI**（`claude`）
2. **Cursor CLI**（`cursor-agent`，也可能叫 `agent`，是同一支程式的兩個名字）

找到的話，每次分類會用該 CLI 的非互動模式（`-p --output-format json`）處理，內容從 stdin 餵進去，直接吃你 CLI 本身的登入額度，`.env` 不用填 `ANTHROPIC_API_KEY`。兩個都沒裝的話，自動退回用 `ANTHROPIC_API_KEY` 呼叫 Anthropic API。

想強制指定用哪一個：

- 只想用 CLI、不想意外退回 API key：`.env` 設 `CLASSIFIER_MODE=cli`。
- 兩個 CLI 都裝了，但想指定用 Cursor 而不是 Claude：`.env` 設 `AGENT_CLI_COMMAND=cursor-agent`。
- 想強制用 API key，即使電腦上有裝 CLI：`.env` 設 `CLASSIFIER_MODE=api`。

`claude` 和 `cursor-agent` 兩個的預設參數（`AGENT_CLI_ARGS`）已經內建好，不用自己設。如果你的 agent CLI 是別的、或是想覆蓋預設參數：

1. 把 `.env` 的 `AGENT_CLI_COMMAND` 改成你實際的指令名稱。
2. 把 `.env` 的 `AGENT_CLI_ARGS` 填上那支 CLI 對應的無互動/腳本模式參數（用空白分隔），例如 `-p --output-format json`。這支程式一律把完整 prompt 從 stdin 餵給它，位置參數只帶一句固定的短指令，並預期輸出是一個 JSON 物件（或 `{ "result": "..." }` 這種外層包裝，程式會自動拆開）。
3. 如果那個 CLI 完全沒有辦法用腳本/非互動模式呼叫，就把 `CLASSIFIER_MODE` 設回 `api`，改用 Anthropic API key。

CLI 模式呼叫失敗（逾時、指令不存在、輸出不是預期的 JSON）時，那一則內容會回傳錯誤訊息，不會生成筆記，可以直接重送一次。

## 讀取 Notion 頁面

Notion 是重度 JS 渲染的網頁，plain fetch 抓到的只是空殼，所以丟 Notion 連結（`notion.so` / `*.notion.site`）進來時，`extractContent.js` 會自動改用 Playwright 開一個無頭 Chromium 把頁面真正渲染出來，再抓畫面上的文字，其他網址不受影響、還是走原本輕量的 fetch + Readability。

限制：

- **只能讀「已經用 Notion『分享到網路』功能公開」的頁面**。需要登入才能看的私人頁面，Playwright 會看到登入畫面而不是真正內容，程式偵測到抓到的文字太少時會直接回報失敗，不會生出一篇內容是登入畫面的筆記。
- 第一次用之前要記得跑過 `npx playwright install chromium`（見上面安裝步驟），不然會顯示錯誤訊息提醒你補裝。
- 比一般網址慢一些（要開瀏覽器渲染），單則處理時間大概多個幾秒。
- 如果你的 Notion 頁面其實是自己的、常常會丟進來，之後也可以改成用 Notion 官方 API（申請 integration token）讀取，會更快更穩定，只是需要多一道申請/授權設定，目前先用 Playwright 這個不用額外申請的版本。

## 已知限制

- 只在你的電腦開機、程式在跑的時候才能接收新內容；電腦關機或程式沒開，傳給 bot 的訊息不會被處理。
- 一般網址擷取用 Readability 抓正文，遇到需要登入、大量 JS 動態載入、或有反爬蟲機制的網站可能抓不到內容——這種情況筆記還是會生成，但內文只能靠標題/網址和你附的說明判斷分類，不會有網頁全文。Notion 連結走 Playwright，見上一節。
- 目前分類判斷只靠 Claude 的知識和抓到的網頁內容，不會主動上網搜尋補充資料（跟一開始手動幫你整理 Claude Code 那篇不同，那次是我手動額外查證官方文件）。如果之後想要「自動上網補充查證」的進階版本，可以再加。

## 專案結構

```
obsidian-inbox-bot/
├── .env.example        設定檔範本
├── package.json
├── public/
│   └── index.html       網頁表單
└── src/
    ├── index.js          啟動進入點（同時開 web server + telegram bot）
    ├── config.js         讀取 .env、檢查設定
    ├── taxonomy.js        分類規則（可自行調整）
    ├── extractContent.js  抓網頁、抽正文
    ├── promptBuilder.js    組出給 API/CLI 共用的 prompt 內容
    ├── classify.js         依 CLASSIFIER_MODE 分派給 API 版或 CLI 版
    ├── classifyViaApi.js   走 Anthropic API + tool-use 做分類
    ├── classifyViaCli.js   走本機 agent CLI（如 claude -p）做分類
    ├── writeNote.js        寫入 .md 檔到 vault
    ├── pipeline.js         串起以上流程，web/telegram 共用
    ├── server.js           Express 網頁伺服器
    └── bot.js              Telegram bot
```
