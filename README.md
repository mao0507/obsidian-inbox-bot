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
   - **強烈建議設定白名單**，不然任何人只要知道這個 bot 的用戶名都能傳訊息觸發分類，見下面「限制 Telegram 使用者」。
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

## 分類架構

打開 `src/taxonomy.js`：

- `FLAT_CATEGORIES`：`01 Knowledge`、`03 Snippets`、`04 Bugs` 這三個是**扁平資料夾**，不分技術子資料夾——筆記直接放進資料夾本身，技術用 tags 標註（例如一篇筆記可以同時貼 `Vue` 和 `TypeScript`）。這是為了解決「內容橫跨兩個技術時，樹狀子資料夾逼你只能二選一」的問題：以前 `01 Knowledge/Vue` 和 `01 Knowledge/TypeScript` 分開，一篇同時講兩者的筆記只能塞一邊；現在都在 `01 Knowledge` 底下，靠 tags 區分。
- `NESTED_TAXONOMY`：其餘分類（`00 Inbox`、`02 Projects`、`Assets`）維持樹狀子資料夾，因為這些子分類彼此互斥，不會有跨分類的問題。要加新子分類，直接在對應陣列裡加一行字串即可，不用改其他程式碼。
- `DYNAMIC_TAXONOMY`：至少有一層子資料夾不是固定清單、由 AI 依內容動態決定。每個分類用 `levels` 陣列描述每一層是 `fixed`（固定選項清單）還是 `free`（AI 自己取名），目前有三個：
  - `07 旅遊`：兩層都是 `free`，依文章描述的地區組成「國家/城市或地區」，例如 `07 旅遊/台灣/台中`、`07 旅遊/日本/北海道`。地區不明確時退回 `00 Inbox/待整理`。
  - `06 AI`：第一層 `free`（工具名稱，例如 `ClaudeCode`、`Cursor`、`OpenAI`），第二層 `fixed`（`提示詞庫`/`教學文章`/`新聞動態`/`工具比較`），例如 `06 AI/ClaudeCode/教學文章`。橫跨多個工具或講產業整體的內容，工具名稱層會填 `綜合`。
  - `05 Learning`：第一層 `fixed`（`書籍`/`課程`/`文章整理`），第二層 `free`（主題或書名），例如 `05 Learning/書籍/原子習慣`。
  要加新的動態分類，在 `DYNAMIC_TAXONOMY` 裡加一個 key，照格式設定 `levels` 和 `hint` 即可。
- `RULES`：文字描述的分類規則，可以照自己習慣改寫，AI 會照這份規則判斷。
- `isValidFolder(folder)`：驗證 AI 回傳的 folder 是否合法（扁平/樹狀分類要完全對上清單，動態分類檢查階層數與每層的 fixed/free 規則）。分類邏輯（`classifyViaApi.js`、`classifyViaCli.js`）都會用這個驗證，不合法就自動退回 `00 Inbox/待整理`。

`06 AI` 是獨立於 `05 Learning` 之外的頂層分類，AI 相關內容（工具教學、提示詞庫、新聞動態、工具比較）都會被分到這裡，而不是混進一般的 `05 Learning`。

動態分類（`06 AI`、`05 Learning`、`07 旅遊`）裡由 AI 自訂的那一層，不用先在 `taxonomy.js` 裡把所有可能值列出來，AI 會依內容自己建立對應的子資料夾。為了避免同一個工具/主題/地區每次被取成不同的名稱變體（例如 `ClaudeCode` 跟 `Claude Code` 分開兩個資料夾），`src/vaultScan.js` 每次分類前會先掃描 vault 裡動態分類已經存在的名稱，放進 prompt 讓 AI 優先重複使用既有名稱。

改完存檔、重新 `npm start` 即可生效。

## 開發模式（自動重啟）

改程式碼後不想每次手動關掉再重開終端機，開發時用：

```
npm run dev
```

這是用 Node 內建的 `--watch`（`node --watch src/index.js`），`src/` 底下任何檔案存檔都會自動重啟整個程式（web server + Telegram bot 一起重開），不用額外裝套件。缺點：

- 重啟的瞬間 Telegram bot 會斷線再重連，處理到一半的訊息可能要重送。
- 跟平常一樣，同一時間只能跑一個（另開一個 `npm run dev` 或 `npm start` 會撞成 Telegram 409 Conflict，見下面「限制 Telegram 使用者」前的說明）。
- 需要 Node 18.11 以上（`node --version` 確認）。

正式使用（不是在改程式碼）還是用 `npm start`，沒有監看檔案的額外負擔。

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

## 圖片自動存進 Eagle（選用）

文章裡的圖片可以自動匯入 [Eagle](https://eagle.cool/)（圖片管理 App），並依照跟 Obsidian 一樣的分類路徑在 Eagle 裡建立對應資料夾。

**前置需求**：電腦上要裝 Eagle App，新增筆記時 Eagle 要是開著的狀態（這支程式是透過 Eagle 的本機 API 溝通，Eagle 沒開就連不到）。

設定 `.env`：

```
EAGLE_ENABLED=true
```

設定好、重啟程式之後：

1. 抓文章時，除了正文之外也會順便抓文中的圖片網址（會濾掉看起來像 icon/logo/追蹤像素的圖，最多留 15 張）。
2. AI 分類完成、決定好資料夾之後（例如 `07 旅遊/日本/北海道`），這支程式會在 Eagle 裡確保有一模一樣的巢狀資料夾——沒有的話自動建立，有的話直接沿用，不會重複建立。
3. 圖片網址交給 Eagle 的 `addFromURLs` API，讓 Eagle 自己下載並存進剛剛對應的資料夾，同時帶上這篇筆記的 tags、來源網址。
4. 匯入成功的圖片會在 Obsidian 筆記正文最後加上一段「## 相關圖片（Eagle）」，用 `eagle://item/...` 深連結列出來，點了會直接跳到 Eagle 裡對應的圖片。
5. Telegram 回覆、網頁結果都會多一行狀態：🖼️ 已存 N 張圖片到 Eagle，或是失敗時顯示錯誤原因（筆記本身一定已經正常寫進本機，Eagle 同步失敗不影響這件事）。

**限制**：

- Eagle 本機 API 只能「給網址讓 Eagle 自己下載」，沒有辦法直接上傳本機檔案，所以圖片一定要是文章裡可以公開存取的網址。
- 一篇文章完全沒有圖片、或圖片被判斷是裝飾用小圖（icon/logo 之類）時，不會呼叫 Eagle，也不會在 Eagle 裡建空資料夾。
- `eagle://item/...` 深連結指到的是「剛剛匯入的那幾筆」，判斷方式是抓該 Eagle 資料夾裡最新建立的幾筆——如果你在存筆記的同一瞬間剛好也手動在 Eagle 裡匯入東西到同一個資料夾，連結可能會對不準（機率很低，正常使用不會遇到）。

### 圖片再備份一份到你自己的 git repo

上面那個是把圖片交給 Eagle App 處理，跟 Eagle 本身有沒有開著綁在一起。如果你想要「不管 Eagle 開不開，只要文章有抓到圖片就把圖片檔案本身存進一個我自己的 git repo」，這是另一件獨立的事，兩個可以都開、只開一個，或都不開。

設定 `.env`（`VAULT_GIT_REMOTE` 的圖片版，用法完全一樣）：

```
EAGLE_GIT_REMOTE=https://github.com/your-name/eagle-images.git
```

設定好、重啟程式之後：

1. 文章裡抓到的圖片網址，這支程式會自己下載下來（不需要 Eagle App、不透過 Eagle 的 API），存到本機一個資料夾（預設是 vault 同一層的 `Eagle Images` 資料夾，可以用 `EAGLE_IMAGES_PATH` 改成別的路徑），並依照跟 Obsidian 一樣的分類路徑建立同構的子資料夾（例如 `Eagle Images/07 旅遊/日本/北海道/`）。
2. 存好之後自動 `git add -A` + commit + push 到 `EAGLE_GIT_REMOTE`。第一次會自動 `git init` 這個資料夾、建立 remote，行為跟 `VAULT_GIT_REMOTE` 那套完全一樣（同一套底層邏輯），包括 push 前會先 `pull --rebase` 避免落後遠端被拒絕、認證方式一樣要先在電腦上設定好（Git Credential Manager 或 SSH key），沒設定好會直接失敗並印錯誤，不會卡住整支程式。
3. 個別圖片下載失敗（連不到、404、檔案超過 20MB）不會讓整批失敗，會跳過那張繼續處理其他張，最後一起 commit。
4. Telegram 回覆、網頁結果會多一行狀態：📦 已備份 N 張圖片到 Eagle 圖片 git，或失敗原因。

**限制**：跟上面一樣，完全沒有圖片時不會做任何事；圖片網址一定要能公開下載到（不支援需要登入才能看的圖）。

### 圖片直接內嵌在筆記正文裡

只要 `EAGLE_ENABLED` 或 `EAGLE_GIT_ENABLED` 有開一個（不需要兩個都開），文章裡抓到的圖片除了上面的處理之外，還會額外下載一份到 vault 裡跟筆記本身同一個資料夾，並在筆記正文最後加上一段「## 圖片」，用 Obsidian 的 `![[檔名]]` 內嵌語法把圖片直接嵌進去——打開筆記就能直接看到圖，不用點連結、不用另外開 Eagle App。

這跟「## 相關圖片（Eagle）」是兩段不同的東西，會同時出現在同一篇筆記裡：內嵌那段是給你打開筆記直接看圖用的，Eagle 連結那段是給你想跳去 Eagle App 裡整理標籤用的。

不想要圖片實體存進 vault 資料夾（例如 vault 也有另外同步到雲端、不想佔空間），把 `EAGLE_ENABLED` 和 `EAGLE_GIT_ENABLED` 都設成 `false` 或不設定就好，這個內嵌功能就不會動作。

Telegram 回覆、網頁結果會多一行狀態：🖼️ 已內嵌 N 張圖片到筆記，或失敗原因。

## 從已收錄的筆記查詢資料（/ask）

不是要新增筆記，而是想問「我之前存過的東西裡有沒有相關資料」，在 Telegram 用：

```
/ask 北海道有什麼景點
/ask ClaudeCode 有什麼省 token 的技巧
/ask Vue3 的 Pinia 要怎麼用
```

運作方式：

1. 先在本機用關鍵字比對（`src/noteIndex.js`）從 vault 所有筆記的標題、tags、摘要、內文裡找出最相關的幾篇，不需要呼叫 AI，很快。完全找不到相關筆記的話會直接回覆「沒有相關資料」，不會浪費一次 AI 呼叫。
2. 找到的話，把這幾篇筆記的完整內容連同你的問題一起丟給 AI（沿用 `CLASSIFIER_MODE` 設定，跟平常分類文章用同一套：本機 CLI 或 Anthropic API），並明確要求「只能根據提供的筆記內容回答，不能瞎掰、不能用自己的知識庫補充」。
3. AI 的回答會直接回覆在 Telegram，結尾會附上它實際引用了哪幾篇筆記。

**限制**：這是關鍵字比對，不是語意搜尋，找不到同義詞（例如筆記裡寫「函式」，你問「function」大概率搜不到，除非兩者都直接出現在筆記某處）。筆記數量多、內容龐大時只會取最相關的前 8 篇、每篇內文超過 3000 字會截斷，避免單次問答內容太大。

## 自動同步筆記到 Git（選用）

想讓 vault 裡的筆記自動備份/同步到你自己的 git repo（GitHub、GitLab、自架 Gitea 都可以），設定 `.env` 的：

```
VAULT_GIT_REMOTE=https://github.com/your-name/obsidian-vault.git
VAULT_GIT_BRANCH=main
```

設定好、重啟程式之後：

- 之後每次透過 Telegram/網頁新增一篇筆記，寫入本機 vault 完成後，程式會自動 `git add -A` + `git commit` + `git push` 到這個 remote。因為每次都是 `add -A`，如果你在兩次新增筆記之間手動在 Obsidian 裡搬移、改名、刪除了其他筆記，那些異動也會一起被帶上去。
- 第一次同步時，如果 vault 資料夾還不是 git repo，程式會自動幫你 `git init`、建一個忽略 Obsidian 本機狀態檔的 `.gitignore`（`.obsidian/workspace.json` 等）、加上 `remote origin`。
- 每次 push 前會先嘗試 `git pull --rebase`，避免你同時在別的裝置（例如手機用 Obsidian Git 外掛）也有改動時整包 push 失敗。
- Telegram 回覆、網頁結果都會多一行同步狀態：🔄 已同步到 Git，或是同步失敗時顯示錯誤原因（筆記本身一定已經正常存進本機 vault，git 同步失敗不影響這件事）。

**帳號認證**：這支程式是背景執行、不會跳出視窗讓你輸入帳號密碼，所以 push 用的認證要先在電腦上設定好：

- 用 HTTPS 網址：Windows 上通常搭配 [Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager) 就會自動記住登入，第一次可以手動在終端機對這個 repo 做一次 `git push` 讓它跳出登入視窗、之後就會快取。
- 用 SSH 網址（`git@github.com:...`）：電腦要先產生 SSH key 並加到 GitHub/GitLab 帳號，確認 `ssh -T git@github.com` 之類的指令能成功連線不用密碼。

如果認證沒設定好，push 會直接失敗並把錯誤訊息印在終端機（不會卡住整個程式），筆記還是會正常留在本機。

**手動同步**：如果你直接在 Obsidian 裡改了東西、不想等下一篇新筆記才順便同步，可以手動跑：

```
npm run vault:sync
```

## 限制 Telegram 使用者

Telegram bot 預設沒有身分驗證，只要知道 bot 的用戶名，任何人都能傳訊息給它、觸發分類、寫進你的 vault。用 `.env` 的 `TELEGRAM_ALLOWED_USER_IDS` 設定白名單就能擋掉：

1. 先照上面步驟啟動 bot（`TELEGRAM_ALLOWED_USER_IDS` 先留空）。這時候終端機會印出一行警告，提醒你目前任何人都能用。
2. 在 Telegram 傳 `/whoami` 或 `/id` 給你的 bot，它會回覆你的 Telegram user ID（一串數字）。
3. 把這個 ID 填進 `.env` 的 `TELEGRAM_ALLOWED_USER_IDS`，例如：
   ```
   TELEGRAM_ALLOWED_USER_IDS=123456789
   ```
   要開放給多人用，用逗號分隔多個 ID：`TELEGRAM_ALLOWED_USER_IDS=123456789,987654321`
4. 重新 `npm start`。之後只有清單裡的 user ID 能傳訊息給 bot；不在清單裡的人傳訊息會收到一句「你沒有權限」的回覆（同時附上他們自己的 user ID，不會處理內容、也不會寫進你的 vault）。

沒有設定白名單的話，每次啟動都會在終端機看到警告，提醒你目前是完全公開的狀態。

## 讀取 Notion 頁面

Notion 是重度 JS 渲染的網頁，plain fetch 抓到的只是空殼，所以丟 Notion 連結（`notion.so` / `*.notion.site`）進來時，`extractContent.js` 會自動改用 Playwright 開一個無頭 Chromium 把頁面真正渲染出來，再抓畫面上的文字，其他網址不受影響、還是走原本輕量的 fetch + Readability。

限制：

- **只能讀「已經用 Notion『分享到網路』功能公開」的頁面**。需要登入才能看的私人頁面，Playwright 會看到登入畫面而不是真正內容，程式偵測到抓到的文字太少時會直接回報失敗，不會生出一篇內容是登入畫面的筆記。
- 第一次用之前要記得跑過 `npx playwright install chromium`（見上面安裝步驟），不然會顯示錯誤訊息提醒你補裝。這個指令預設會連完整版 Chromium 一起裝（不只是精簡的 headless shell），程式會優先用完整版，相容性比較好。
- 比一般網址慢一些（要開瀏覽器渲染），單則處理時間大概多個幾秒。
- 如果你的 Notion 頁面其實是自己的、常常會丟進來，之後也可以改成用 Notion 官方 API（申請 integration token）讀取，會更快更穩定，只是需要多一道申請/授權設定，目前先用 Playwright 這個不用額外申請的版本。

想單獨測試抓不抓得到，不用開整個 bot、也不會呼叫 AI 或寫進 vault：
```bash
node scripts/test-notion.js https://你的-notion-頁面網址
```
成功會印出標題和內文預覽，失敗會告訴你原因（通常是頁面沒公開分享，或還沒跑 `npx playwright install chromium`）。

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
    ├── vaultScan.js        掃描動態分類既有名稱，維持 AI 命名一致
    ├── extractContent.js  抓網頁、抽正文、抽文中圖片網址
    ├── promptBuilder.js    組出給 API/CLI 共用的 prompt 內容
    ├── cliRunner.js         spawn 本機 agent CLI 的共用邏輯（分類、/ask 都會用到）
    ├── classify.js         依 CLASSIFIER_MODE 分派給 API 版或 CLI 版
    ├── classifyViaApi.js   走 Anthropic API + tool-use 做分類
    ├── classifyViaCli.js   走本機 agent CLI（如 claude -p）做分類
    ├── imageDownload.js      下載圖片、決定副檔名/檔名的共用邏輯（eagleImageArchive.js、imageEmbed.js 共用）
    ├── eagleSync.js          把文中圖片匯入 Eagle App、依分類建同構資料夾（選用）
    ├── eagleImageArchive.js  下載文中圖片、備份到獨立的 EAGLE_GIT_REMOTE（選用，不需要 Eagle App）
    ├── imageEmbed.js         下載文中圖片進 vault 筆記所在資料夾，供 ![[檔名]] 內嵌顯示（選用）
    ├── writeNote.js        寫入 .md 檔到 vault（含內嵌圖片、Eagle 圖片連結）
    ├── gitSyncFactory.js     「某資料夾自動 commit+push 到某 remote」的共用邏輯
    ├── gitSync.js           筆記寫入後自動 commit + push 到 VAULT_GIT_REMOTE（選用，底層用 gitSyncFactory.js）
    ├── noteIndex.js         讀取 vault 所有筆記、關鍵字比對找出相關筆記（給 /ask 用）
    ├── askAi.js              呼叫本機 CLI 或 API 做純文字問答（不是結構化分類）
    ├── askVault.js           整合 noteIndex + askAi，處理 /ask 的完整流程
    ├── pipeline.js         串起以上流程，web/telegram 共用
    ├── server.js           Express 網頁伺服器
    └── bot.js              Telegram bot（含 /ask 指令）

scripts/
  └── git-sync.js            手動觸發一次 vault git 同步（npm run vault:sync）
```
