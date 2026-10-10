# Obsidian Inbox Bot

丟內容（文字、想法、網址）進來，Claude 會自動分類、補充說明、寫成筆記存進你的 Obsidian vault。支援兩種入口：網頁表單、Telegram bot，共用同一套分類邏輯。Telegram 另外支援 `/ask`（查已存筆記）、`/browse`（瀏覽分類、往下查文章）和 `/notebook`（用 NotebookLM 做真正的網路研究，選用，見下面對應章節）。

跑在你自己的電腦上，需要保持這個程式在背景執行（開著終端機視窗，或設成開機啟動的背景服務）才能持續接收內容。

## 需要準備的東西

1. **Node.js 18 以上 + pnpm**：<https://nodejs.org> 下載 LTS 版安裝，再執行 `corepack enable pnpm` 啟用 pnpm。安裝完在終端機打 `node -v`、`pnpm -v` 確認。
2. **分類用的 AI，二選一**：
   - **本機已裝的 agent CLI（預設、推薦）**：Claude Code CLI（`claude`）或 Cursor CLI（`cursor-agent`）擇一裝好、登入過就行，什麼都不用多做——程式啟動時會自動偵測到，直接用它做分類，不用另外申請/付費 API key。兩個都裝的話預設優先用 `claude`。
   - **Anthropic API key**：兩個 CLI 都沒裝的話，去 <https://console.anthropic.com/settings/keys> 申請一把，用量計費，分類/整理一篇內容通常幾分錢台幣等級的費用。
3. **（要用 Telegram bot 的話）Telegram bot token**：
   - Telegram 搜尋 `@BotFather` → 傳 `/newbot` → 照指示取名 → 拿到一組 `123456:ABC-xxxxxxxx` 格式的 token。
   - 之後在 Telegram 找到你剛建立的 bot，按「開始」或傳 `/start` 給它，才能開始跟它聊天。
   - **強烈建議設定白名單**，不然任何人只要知道這個 bot 的用戶名都能傳訊息觸發分類，見下面「限制 Telegram 使用者」。
4. **（要丟 Notion 頁面連結的話）Playwright 瀏覽器核心**：`pnpm install` 之後多跑一次 `pnpm exec playwright install chromium`（見下面「安裝步驟」）。不丟 Notion 連結的話可以跳過，其他網址不受影響。

## 安裝步驟

1. 打開終端機，切到這個資料夾：
   ```bash
   cd obsidian-inbox-bot
   pnpm install
   ```
   如果會丟 Notion 頁面連結進來，再多跑一次（下載 Chromium，約幾百 MB，只需跑一次）：
   ```bash
   pnpm exec playwright install chromium
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
3. 註冊成背景服務（登入電腦後自動啟動、掛掉自動重啟，Windows / macOS / Linux 都適用）：
   ```bash
   pnpm run service:install
   ```
   Windows 也可以直接雙擊 `啟動.cmd`，它會先 `pnpm install` 再執行上面這行。
   之後不用再開終端機。常用指令：

   | 指令 | 用途 |
   |---|---|
   | `pnpm run service:logs` | 即時看 log（Ctrl+C 離開，不會停掉服務） |
   | `pnpm run service:restart` | 改完 `.env` 或更新程式後重新啟動 |
   | `pnpm run service:uninstall` | 停止並移除開機啟動 |

   log 裡看到這兩行代表成功：
   ```
   [classifier] 使用本機 agent CLI「claude」做分類，不需要 API key
   [telegram] bot 已啟動（polling 模式）
   ```
   `service:install` 也會檢查 git、yt-dlp、notebooklm 這幾個外部工具，缺少的會印出該作業系統的安裝指令（不會自動安裝，缺了只是對應功能停用）。
   換了 Node 版本或搬動專案資料夾之後，重跑一次 `pnpm run service:install`。

## 怎麼用

- **Telegram**：直接傳訊息或網址給你的 bot，它會回覆分類結果和存檔位置。在聊天輸入框打 `/` 會跳出指令選單（`/ask`、`/whoami`，裝了 notebooklm CLI 的話還有 `/notebook`），這份選單是啟動時自動設定的，只會列出「現在真的能用」的指令。

分類完成後，直接去 Obsidian 打開對應資料夾，就會看到新筆記（如果 Obsidian 正開著，會自動偵測到新檔案）。

## 分類架構

資料夾固定三層：**大項目 / 中項目 / 主 tag**，例如 `技術/前端框架/Vue`、`AI/編程助手/ClaudeCode`、`旅遊/日本/北海道`。

- **大項目、中項目**：固定清單，寫在 `src/taxonomy.js` 的 `TAXONOMY`。AI 只能從清單挑，不能自己發明資料夾，所以同一個主題不會被拆成兩個資料夾。
  - `技術`：前端框架、語言基礎、樣式與UI、建置與工具、跨平台與行動、後端與API、資料庫、網路與通訊、DevOps與部署、架構與設計模式、演算法與資料結構
  - `AI`：編程助手、模型與聊天、Agent與自動化、提示詞工程、設計與創作、產業動態、工具比較
  - `學習`：書籍、課程、思維與方法、職涯、理財
  - `旅遊`：中項目是國家（自訂）
  - `生活`：健康運動、料理飲食、購物開箱、居家、娛樂
  - `專案`：中項目是專案名（自訂）
  - `收件匣`：暫時紀錄、靈感、待整理（只有兩層，不分 tag）
- **主 tag**：第三層資料夾，是這篇筆記最主要在講的具體技術/工具/書名/地區；其他 tag 只放在 frontmatter。
- **內容型態**（觀念／片段／踩雷／其他）不是資料夾，放在 frontmatter 的 `kind`，可以用 Obsidian 搜尋或 Dataview 篩選。
- AI 回傳的分類不在清單裡時，自動退回 `收件匣/待整理`。

要加新的中項目，在 `TAXONOMY` 對應的陣列加一個字串，重新啟動即可（`pnpm run service:restart`）。

### tag 詞彙表（`_系統/tags.json`）

所有 tag 都經過 vault 裡的 `_系統/tags.json` 正規化（跟著 vault 用 git 同步，換電腦也帶得走）：

```json
{ "tags": { "PostgreSQL": ["Postgres", "PG"], "Vue": ["Vue3", "Vue2"] } }
```

- 大小寫、空白、`-` `_` `.` 不同的寫法自動視為同一個 tag（`Claude Code` = `claude-code` = `ClaudeCode`）。
- 語意上的別名（`Vue3` → `Vue`）寫在別名清單裡；你可以直接編輯這個檔案增減別名。
- 詞彙表裡沒有的 tag 會自動新增，Telegram 回覆會標出「🆕 新 tag」。發現它其實跟既有的是同一個，就把它加進既有 tag 的別名清單。
- 每次分類前，prompt 會帶上「既有資料夾（含篇數）」與詞彙表，AI 會優先放進已經有的資料夾。

## 自動去重、關聯連結、分類地圖

三個之前沒有、後來補上的行為，都在 `pipeline.js` 裡串接，web/Telegram 共用：

- **來源網址去重**（`src/duplicateCheck.js`）：分類之前先比對 vault 裡所有筆記 frontmatter 的 `source`/`other_sources`，網址正規化後（拿掉 `utm_*`、`fbclid`、`srsltid` 等追蹤參數、結尾斜線）完全相同就視為同一篇，直接回報既有筆記路徑、不建立新筆記、也不浪費一次 AI 呼叫。Telegram 會回覆「📎 這篇文章已經存過了」，網頁版也會顯示對應訊息。
- **雙向關聯連結**（`src/relatedNotes.js`）：筆記寫入後自動判斷「相關筆記」並互相補上 `[[wikilink]]`——動態分類（`AI`/`學習`/`旅遊`）用「同一個最深層資料夾」判斷相關，扁平分類（`知識庫`/`程式片段`/`踩雷筆記`）用「至少共用一個 tag」判斷相關。只會新增連結，不會動到既有的「## 相關筆記」內容（包含你自己手動加的）。
- **分類地圖自動維護**（`src/mocSync.js`）：動態分類（`AI`/`學習`/`旅遊`）每次有新筆記進來，會整份重新掃描該分類資料夾、重新產生一份 `<分類>地圖.md`（例如 `AI/AI地圖.md`），依實際資料夾巢狀結構列出所有筆記連結。**這個檔案是自動產生的索引，不要手動編輯**——下次有新筆記進來會整份覆寫，手動加的內容會不見。想備註什麼，寫在筆記本身裡就好。`知識庫`（扁平分類）不會有自動地圖，因為技術靠 tags 分、資料夾本身沒有主題結構可以拿來分組。

## 開發模式（自動重啟）

改程式碼後不想每次手動關掉再重開終端機，開發時用：

```
pnpm dev
```

這是用 Node 內建的 `--watch`（`node --watch src/index.js`），`src/` 底下任何檔案存檔都會自動重啟整個程式（Telegram bot 跟著重開），不用額外裝套件。缺點：

- 重啟的瞬間 Telegram bot 會斷線再重連，處理到一半的訊息可能要重送。
- 跟平常一樣，同一時間只能跑一個（另開一個 `pnpm dev` 或 `pnpm start` 會撞成 Telegram 409 Conflict，見下面「限制 Telegram 使用者」前的說明）。
- 需要 Node 18.11 以上（`node --version` 確認）。

正式使用（不是在改程式碼）用 `pnpm run service:install` 註冊的背景服務。開發前先 `pnpm run service:uninstall` 停掉背景服務，不然兩個同時跑會撞成 Telegram 409 Conflict。

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

## 瀏覽分類、往下查詢文章（/browse）

`/ask` 要先想好問題，`/browse` 是不知道要問什麼、單純想逛逛目前 vault 裡有哪些分類、某個分類底下有什麼文章時用的。Telegram 傳：

```
/browse
```

會列出 vault 目前所有頂層分類（每個都附筆記數），底下用按鈕操作：

- 點分類 → 往下顯示它的子分類（動態/樹狀分類，例如 `AI` → 工具名稱 → 教學文章/新聞動態...）或直接顯示這個分類裡的文章（扁平分類，例如 `知識庫`）。
- 點文章 → 顯示標題、摘要、標籤、路徑跟內文預覽（超過 800 字會截斷，完整內容還是要到 Obsidian 打開）。
- 文章數量多的話會分頁（每頁 8 篇），底部有「上一頁/下一頁」。
- 「⬅️ 上一層」「🏠 分類總覽」隨時可以往回走。

這是直接掃描 vault 磁碟上目前實際的資料夾/檔案，不是 `taxonomy.js` 裡設定的規則清單——兩者通常一致，但還沒有任何筆記的動態分類子資料夾不會出現在這裡（因為資料夾根本還不存在）。純瀏覽，不會新增或修改任何筆記。

**限制**：按鈕背後對應的資料夾路徑存在記憶體裡，bot 重啟後舊訊息上的按鈕會失效（點了會提示「這個按鈕過期了」），重新 `/browse` 一次就好。

## 用 NotebookLM 做深度研究（/notebook，選用）

`/ask` 是查「你已經存過的筆記」；`/notebook` 不一樣，是真的去網路上做研究、找新資料，用的是 Google NotebookLM（透過非官方套件 [notebooklm-py](https://github.com/teng-lin/notebooklm-py)）。研究完的報告會照平常同一套分類規則（`taxonomy.js`）整理成一篇新筆記，正常走關聯連結、分類地圖、git 同步這些流程，跟你手動丟內容進來沒有兩樣。

### 安裝 notebooklm-py CLI（跟這支 bot 分開裝）

這是獨立的 Python 套件，`npm install` 不會幫你裝，因為登入要開真的瀏覽器做 Google 帳號驗證，要在你自己這台電腦（有 GUI）的終端機另外跑：

```bash
# 沒有 uv 的話先裝：curl -LsSf https://astral.sh/uv/install.sh | sh（或 brew install uv / winget install astral-sh.uv）
uv tool install "notebooklm-py[browser]"

notebooklm login                       # 第一次會下載 Chromium，接著開瀏覽器讓你登入 Google 帳號
notebooklm auth check --test --json    # 確認成功，應該回傳 "status": "ok"
```

裝好、登入過之後，重新啟動這支 bot（`pnpm start`），啟動訊息會多一行：

```
[notebooklm] 已偵測到「notebooklm」指令，/notebook 研究功能可以使用（research mode: fast）
```

如果沒看到這行、只看到「找不到指令」的警告，代表 `notebooklm` 沒有裝好或不在 PATH 上，`/notebook` 指令會回覆說明訊息、但不影響 bot 其他功能。

### 怎麼用

Telegram 傳：

```
/notebook 台灣離岸風電現況
/notebook Vue3 跟 React 的 Server Component 差異
/notebook https://www.youtube.com/watch?v=xxxxxxxxxxx
/notebook 幫我研究這部影片 https://www.youtube.com/watch?v=xxxxxxxxxxx 裡面提到的重點，並補充相關背景資料
```

**1. 先確認研究計畫**：bot 會先回一份研究計畫，內容是一個研究問題加上 3～5 個研究角度（有附網址的話，會先讀網址內容再規劃），並附三個按鈕：

- **▶️ 開始研究**：排進研究佇列開始跑。按下之前不佔佇列。
- **✏️ 修改**：直接「回覆」那則計畫訊息，寫下想調整的方向（例如「聚焦台灣，多看漁業衝突」），bot 會依你的意見重新產生計畫。
- **✖️ 取消**

**已經研究過的主題**：規劃時會比對 vault 裡的既有研究筆記（說法不同但主題相同也算）。有找到的話，計畫訊息會顯示「📚 已有相關研究」，按鈕變成：

- **➕ 補充到既有筆記**：在原本的 NotebookLM notebook 上依新計畫加跑 deep research、重新產生報告，並改寫原筆記（檔名與路徑不變，連結不會斷）。
- **🆕 另外新建**：照常開一個新的研究。

**2. 研究**：建立新的 NotebookLM notebook；網址會加為一定納入的來源（YouTube 會自動抓字幕）；用 **Deep Research** 依研究問題搜尋網路並匯入來源；再依研究角度產生一份**繁體中文、每個角度一個章節、附引用**的詳細報告。

**3. 存進 Obsidian**：用跟一般筆記一樣的精讀模板整理（依研究角度分章節、不壓縮、保留引用），文末附摺疊的完整原始報告方便查證。frontmatter 有 `type: research`、`topic`（研究問題）、`notebook_id`（之後想在 NotebookLM 網頁版繼續追問、生成 podcast，都可以用它找到 notebook）。

**產生報告偶爾失敗**：NotebookLM 伺服器端偶爾會把正在產生中的報告直接下架（Google 那邊暫時的速率限制或每日額度用完），`generate report` 已經帶 `--retry 3` 讓 CLI 自己重試；真的還是失敗的話，Telegram 會回覆清楚的中文說明，過一段時間再試通常就會恢復。

**可以連續丟好幾個主題**：研究有自己的一條佇列（同一時間只跑一個，避免撞到 Google 的速率限制），不會擋住一般的收件。排隊中的任務會回覆「排第 N 個」，跑完各自發一則新訊息通知你。佇列存在記憶體裡，bot 重啟會清空。

### 設定

`.env` 兩個相關變數（範本見 `.env.example`）：

- `NOTEBOOKLM_COMMAND`：CLI 指令名稱，留空預設用 `notebooklm`，通常不用改。
- 研究一律使用 Google Deep Research（來源最完整，通常要幾分鐘到半小時），報告以繁體中文產生。
- `NOTEBOOKLM_LOGIN_BROWSER`：登入過期時，自動從這個瀏覽器重新讀取登入 cookie 修復用，預設 `chrome`，見下面「登入過期怎麼辦」。

### 登入過期怎麼辦

NotebookLM 的登入是瀏覽器 cookie，一段時間沒用可能會過期。這支程式會自動做三層嘗試，盡量不需要你手動處理：

1. **背景保活**：bot 啟動後每 12 小時自動呼叫一次 `notebooklm auth refresh`，讓 session 盡量不要走到完全過期。
2. **輕量修復**：真的遇到過期錯誤時，先試一次 `auth refresh`，這對「快過期、還沒完全失效」的情況有機會直接救回來。
3. **借用瀏覽器登入狀態**：如果 (2) 也失敗（代表 session 可能已經真的過期），會再試 `auth refresh --browser-cookies <NOTEBOOKLM_LOGIN_BROWSER>`——直接重新讀取你這台電腦上該瀏覽器（預設 Chrome）目前的 Google 登入 cookie 來修復，等於借用你平常瀏覽器本來就登入著的狀態，不會跳出任何視窗。**前提是那個瀏覽器裡本身要有一個還有效的 Google 登入 session**（例如你平常會用 Chrome 開 Gmail、NotebookLM 網頁版之類）。

任一層成功都會自動重試整個研究流程一次，不用你介入。只有當瀏覽器裡的 Google 登入也失效了（例如你把 Chrome 裡的 Google 帳號登出了、或這台電腦上根本沒有登入過該瀏覽器），三層都會失敗——這是唯一真的沒辦法自動化的情況，因為重新走一次 Google 帳號驗證，本質上需要一個人親自完成，背景程式沒有辦法自動幫你點過去。這時 `/notebook` 會直接回覆「NotebookLM 登入已過期，請執行 notebooklm login 重新登入」，照著在終端機跑：

```bash
notebooklm login
```

登入完成後不用重啟 bot，下一次 `/notebook` 就會正常運作。

### 限制

- 每次 `/notebook` 都會在你的 NotebookLM 帳號裡建立一個新 notebook，不會自動刪除——累積多了可以自己到 [notebooklm.google.com](https://notebooklm.google.com) 手動整理。
- 這是非官方套件，用的是 Google 沒有公開文件的內部 API，可能哪天忽然失效或改版，見套件本身的 [troubleshooting 文件](https://github.com/teng-lin/notebooklm-py/blob/main/docs/troubleshooting.md)。
- 跟一般丟內容進來一樣，最終筆記的資料夾/標籤是由 AI 依 `taxonomy.js` 規則判斷，不保證每次都分到你預期的分類，不滿意可以之後手動搬移（連同 `taxonomy.js` 一起改，見上面「分類架構」一節）。

### 也能用 Claude Code 直接觸發（不用開 Telegram）

這個 repo 附了一個 Claude Code skill（`.claude/skills/notebook-research/SKILL.md`），在這個資料夾裡用 Claude Code 時，直接跟它說「幫我研究一下 XXX」或丟一個網址要它研究，Claude 就會觸發跟 `/notebook` 完全同一套流程，不需要開 Telegram。

背後是一支獨立的命令列腳本，你自己也可以直接跑：

```bash
node scripts/notebook-research-cli.js "台灣離岸風電現況"
node scripts/notebook-research-cli.js "https://www.youtube.com/watch?v=xxxxxxxxxxx"
# 或用 npm script（注意中間要加 --）：
pnpm run notebook -- "台灣離岸風電現況"
```

結果一樣是研究完直接寫進 Obsidian vault、印出存檔位置；跟 Telegram 的差別只在觸發管道，底層邏輯（`src/pipeline.js` 的 `processNotebookResearch`）完全共用，行為（網址先理解內容、一般主題先摘要需求、分類規則、關聯連結、git 同步）都一致。

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

**index.lock 錯誤**：如果看到「Unable to create '.git/index.lock': File exists」，通常是之前有個 git process 被強制中斷（例如程式被砍掉、電腦睡眠中斷、或 Obsidian 的 Git 外掛跟這支程式同時在動）留下的殘留鎖檔。程式偵測到這個錯誤時，如果鎖檔已經存在超過 45 秒（判定是殘留的，不是真的有其他 process 在跑），會自動刪除並重試一次，通常不用手動處理。真的還是失敗（例如鎖檔一直很新，代表真的有其他程式在同時操作這個 repo）才需要手動確認沒有其他 git process 在跑之後，自己刪除 `.git/index.lock`。另外同一個資料夾的多次同步（網頁、Telegram 一般訊息、`/notebook`）都會自動排隊序列化，不會自己跟自己搶鎖。

**手動同步**：如果你直接在 Obsidian 裡改了東西、不想等下一篇新筆記才順便同步，可以手動跑：

```
pnpm run vault:sync
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
4. 重新 `pnpm start`。之後只有清單裡的 user ID 能傳訊息給 bot；不在清單裡的人傳訊息會收到一句「你沒有權限」的回覆（同時附上他們自己的 user ID，不會處理內容、也不會寫進你的 vault）。

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

## YouTube 影片筆記（選用：yt-dlp）

丟 YouTube 連結（watch、youtu.be、shorts、live 都可以）時，會用 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 抓影片資訊與字幕，整理成跟文章一樣的精讀筆記：

- 字幕優先順序：人工繁中 → 人工簡中 → 人工英文 → 自動產生的字幕（影片原始語言）。筆記一律整理成繁體中文。
- 依影片章節分段（沒有章節就依主題分段），每段標題附上時間戳連結，點了直接跳到影片那一秒。
- frontmatter 會有 `type: video`、`channel`、`duration`。
- 沒有字幕、或這台電腦沒裝 yt-dlp 時，改依標題與影片說明整理，筆記最上方和 Telegram 回覆都會標註。

安裝 yt-dlp（獨立的 CLI，不是 npm 依賴）：Windows `winget install yt-dlp.yt-dlp`、macOS `brew install yt-dlp`、Linux `pipx install yt-dlp`。指令名稱不同時，在 `.env` 設 `YTDLP_COMMAND`。

## 舊筆記重建（改版後一次性）

改版前存的筆記（舊分類、舊模板）可以用新流程整批重建：重新抓原文、套精讀模板、放進新分類樹、改新檔名、產生概念卡，並把全 vault 的連結改指向新筆記。

```bash
pnpm run service:uninstall   # 先停掉背景服務，避免重建期間有新筆記寫入
pnpm run migrate plan        # dry-run：寫出 _系統/migration-plan.md（哪些筆記、同網址合併、原文抓不抓得到），不改任何筆記
pnpm run migrate trial 3     # 先重建 3 組讓你檢查品質；舊筆記保留
pnpm run migrate run         # 重建剩下的全部 → 改寫連結 → 刪除舊筆記 → 重新產生分類地圖
pnpm run service:install
```

- 第一次 `trial`／`run` 前會先 commit 並打 git tag `before-migration`。想反悔就在 vault 資料夾執行 `git reset --hard before-migration`。
- 同一個網址的多篇舊筆記會合併成一篇，保留最早的收錄日期。
- 原文抓不到（網站下架、需要登入、被限流）或原本就沒有網址的筆記，以原筆記內容為來源重建。
- 進度存在 `_系統/migration-state.json`，中斷了可以重跑同一個指令接著做。結果見 `_系統/migration-report.md`。

### 研究筆記（NotebookLM）

```bash
pnpm run migrate research-plan       # AI 把同主題的研究分組（例如 grill-me 的 4 篇合成 1 組），每組附研究計畫，寫出 _系統/migration-research-plan.md
pnpm run migrate research-trial 1    # 先重建 1 組（deep research 每組可能要半小時）
pnpm run migrate research-run        # 重建剩下的 → 改寫連結 → 刪除舊研究筆記
```

- 沿用原本的 NotebookLM notebook（從舊筆記正文解析 notebook id）。同一組有多個 notebook 時，以來源最多的為主體，把其他 notebook 的來源網址匯入，再依研究計畫補跑 deep research、產生新報告。
- notebook 都已經被刪掉的組，改用研究計畫重新研究。
- 新筆記的 frontmatter `notebook_ids` 列出這組所有 notebook，保留最早的收錄日期。

## 已知限制

- 只在你的電腦開機、程式在跑的時候才能接收新內容；電腦關機或程式沒開，傳給 bot 的訊息不會被處理。
- 一般網址擷取用 Readability 抓正文，遇到需要登入、大量 JS 動態載入、或有反爬蟲機制的網站可能抓不到內容——這種情況筆記還是會生成，但內文只能靠標題/網址和你附的說明判斷分類，不會有網頁全文。Notion 連結走 Playwright，見上一節。
- Threads、X（Twitter）這類短文社群貼文，Readability 常常抓不到東西（貼文本來就短，或頁面重度 JS 渲染）。這種情況會自動退而求其次改抓頁面的 `og:title` / `og:description`（社群平台為了讓連結分享有預覽卡片，通常都會在原始 HTML 裡吐出這兩個），抓得到的話筆記還是能正常分類、只是內文只有這段摘要，不是完整貼文；如果連 og 資訊都沒有（例如私人帳號、需要登入才能看），才會真的抓取失敗。
- 目前分類判斷只靠 Claude 的知識和抓到的網頁內容，不會主動上網搜尋補充資料（跟一開始手動幫你整理 Claude Code 那篇不同，那次是我手動額外查證官方文件）。如果之後想要「自動上網補充查證」的進階版本，可以再加。

## 專案結構

```
obsidian-inbox-bot/
├── .env.example        設定檔範本
├── package.json
├── public/
│   └── index.html       網頁表單
└── src/
    ├── index.js          啟動進入點（Telegram bot + NotebookLM 登入保活）
    ├── config.js         讀取 .env、檢查設定
    ├── app.js            composition root：唯一把 config 接到下面各個 module 的地方
    ├── taxonomy.js        分類規則（可自行調整）
    ├── noteStore.js       Vault Note module：筆記的讀、寫、走訪、frontmatter 格式全在這裡
    ├── aiBackends.js      AI backend：本機 agent CLI / Anthropic API 兩個 adapter，interface 相同
    ├── noteDrafter.js     把內容交給 AI 產生已驗證的筆記草稿（必填欄位、資料夾合法性）
    ├── promptBuilder.js    組出分類用的 system / user prompt
    ├── cliRunner.js         spawn 本機 agent CLI 的共用邏輯
    ├── vaultScan.js        列出既有分類資料夾與篇數，讓 AI 優先放進既有資料夾
    ├── tagVocabulary.js    tag 詞彙表（_系統/tags.json）：別名正規化、新 tag 建立
    ├── extractContent.js  抓網頁、抽正文、從文字抓網址
    ├── duplicateCheck.js    分類前比對來源網址，vault 裡已有同一篇文章就直接回報、不重複建立
    ├── relatedNotes.js      筆記寫入後跟相關的既有筆記互相補上雙向 [[wikilink]]
    ├── mocSync.js           動態分類（AI/學習/旅遊）重新產生 <分類>地圖.md 索引
    ├── gitSyncFactory.js     「某資料夾自動 commit+push 到某 remote」的共用邏輯
    ├── gitSync.js           筆記寫入後自動 commit + push 到 VAULT_GIT_REMOTE（選用，底層用 gitSyncFactory.js）
    ├── noteIndex.js         關鍵字比對找出相關筆記（給 /ask 用）
    ├── askVault.js           整合 noteIndex + AI backend，處理 /ask 的完整流程
    ├── vaultBrowser.js       整理 vault 資料夾/筆記結構，給 /browse 用
    ├── browseView.js         /browse 的 Telegram 畫面與按鈕
    ├── notebookResearch.js   NotebookLM Research module：研究流程、登入過期自動修復（notebooklm CLI 是可替換的 seam）
    ├── taskQueue.js          簡單的記憶體 FIFO 佇列（concurrency=1），/notebook 排隊用
    ├── pipeline.js         串起以上流程：收件、研究、補充研究、舊筆記重建
    ├── migration.js        舊筆記重建：盤點分組、試跑、改寫連結、刪除舊筆記
    └── bot.js              Telegram bot（含 /ask、/browse、/notebook 指令）

test/                     `pnpm test`（node:test，不需要 .env）

scripts/
  ├── git-sync.js                  手動觸發一次 vault git 同步（pnpm run vault:sync）
  └── notebook-research-cli.js     命令列直接觸發一次 NotebookLM 研究（pnpm run notebook -- "..."），給 Claude Code skill 用

.claude/
  └── skills/
      └── notebook-research/
          └── SKILL.md              Claude Code skill：讓 Claude Code 能直接觸發研究流程，不用開 Telegram
```
