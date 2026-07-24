---
name: notebook-research
description: 用 NotebookLM 針對一個主題或網址（包含 YouTube 影片連結）做深度研究，並把研究結果依這個 repo 的分類規則寫成一篇新筆記存進 Obsidian vault。當使用者說「幫我研究...」「用 notebook 查一下...」「幫我研究這部影片/這篇文章」，或丟一個想要深入研究、找更多佐證資料的連結時使用。不是用來查詢已經存在 vault 裡的舊筆記（那是關鍵字查詢，不需要呼叫這支）。
---

# NotebookLM 研究並存進 Obsidian

這個 skill 讓你（Claude Code）觸發跟這個 repo 的 Telegram bot `/notebook` 指令完全同一套研究流程，不需要透過 Telegram。

## 什麼時候用這個 skill

- 使用者要求針對某個主題做研究（例如「幫我研究一下台灣離岸風電現況」）。
- 使用者丟一個網址（尤其 YouTube 影片連結）要求深入研究、整理成筆記。
- 使用者明確提到「notebook」「NotebookLM」要你去查資料、做研究。

**不要**在使用者只是想查「vault 裡已經存過的筆記」時用這個 skill——那種情況引導使用者用 Telegram 的 `/ask` 指令，或直接用 Grep/Read 在 vault 裡找，不需要花時間跑一次全新的網路研究。

## 前置條件

這個功能依賴獨立安裝的 `notebooklm-py` CLI（不是這個 repo 的 npm 依賴），且要先登入過 Google 帳號。如果還沒裝好，執行下面的指令時會直接印出清楚的錯誤訊息告訴你怎麼裝（見 repo 根目錄 `README.md`「用 NotebookLM 做深度研究」章節），照著引導使用者去裝，不用自己猜測安裝步驟。

## 怎麼執行

在這個 repo 的根目錄（package.json 所在的資料夾）執行：

```bash
node scripts/notebook-research-cli.js "<使用者的研究主題或網址，原封不動照使用者說的填進去，不要自己先摘要或改寫>"
```

例如：

```bash
node scripts/notebook-research-cli.js "https://www.youtube.com/watch?v=aR97E7aKEgg"
node scripts/notebook-research-cli.js "台灣離岸風電現況"
```

不需要（也不應該）自己先解讀網址內容或改寫使用者的主題——這支腳本背後（`src/notebookResearch.js`）已經會自動處理：

- 主題是網址（例如 YouTube）：先把網址加進 NotebookLM notebook 當作保證來源、等它處理完，再問 NotebookLM 自己「這個來源在講什麼」來理解內容，不會憑網址字面亂猜。
- 主題是一般文字：先用本機 Claude CLI/API 把使用者可能簡短模糊的輸入摘要成清楚的研究說明，再拿去做網路研究。

你只要把使用者的原始輸入整段傳進去就好。

## 執行時間與等待方式

依主題複雜度跟 `.env` 裡 `NOTEBOOKLM_RESEARCH_MODE` 設定（`fast` 通常幾十秒到幾分鐘；`deep` 可能到二三十分鐘），這支指令可能要跑一段時間才會結束。用 Bash 工具執行時：

- 不要設定過短的 timeout 就放棄，也不要中途取消——這是一個會跑到完成才印出結果的同步指令，沒有回應不代表卡住。
- 過程中終端機會持續印出進度訊息（例如 `[notebooklm] ...`、`[related-notes] ...`、`[git-sync] ...`），這些是正常的過程輸出，不是錯誤。
- 指令結束前不會有其他方式回報進度，耐心等待它印出下面這段最終結果區塊。

## 執行成功後

指令成功會印出類似這樣的區塊，把裡面的重點（標題、資料夾、檔名、摘要、NotebookLM notebook id 等）用自然語言回報給使用者，不用整段貼終端機輸出：

```
================ 研究完成，已存進 Obsidian ================
主題：...
標題：...
資料夾：...
檔名：...
摘要：...
標籤：#... #...
NotebookLM notebook id：...
已同步到 git
=============================================================
```

## 執行失敗時

指令失敗會用非 0 結束碼結束，並在 stderr 印出一句清楚的中文錯誤訊息（例如 CLI 沒裝好、登入過期、下載的報告是空的等）。直接把這句錯誤訊息的重點告訴使用者，並視情況引導後續動作，例如登入過期時提示使用者在終端機執行 `notebooklm login`。不要自己編造沒有在錯誤訊息裡出現的原因。
