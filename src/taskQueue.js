// 簡單的記憶體內 FIFO 任務佇列，concurrency 固定是 1（同一時間只跑一個任務）。
// 目前只有 /notebook 在用：你可以連續丟好幾個研究主題，不會同時併發跑好幾個
// notebooklm 研究（併發跑很容易撞到 Google 帳號的產生速率限制，也很難分清楚
// 哪個進度訊息對應哪個主題），而是排隊依序處理，每個任務跑完各自通知。
//
// 純記憶體實作，bot process 重啟的話佇列會清空——這支程式本來就假設「開著才會動」
// （見 README「已知限制」），跟這個佇列的設計前提一致，不算新增的限制。
const queue = [];
let processing = false;

function pump() {
  if (processing) return;
  const job = queue.shift();
  if (!job) return;
  processing = true;

  (async () => {
    try {
      if (job.onStart) await job.onStart();
      const result = await job.taskFn();
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      processing = false;
      pump();
    }
  })();
}

/**
 * 把一個非同步任務加進佇列，回傳一個 Promise，等真正輪到它執行完（成功或失敗）才 resolve/reject。
 * @param {() => Promise<any>} taskFn 實際要執行的任務
 * @param {object} [options]
 * @param {() => Promise<void>|void} [options.onStart] 任務真正開始執行（輪到它、不是加入佇列那一刻）時呼叫，
 *   可以用來更新「開始處理」的訊息、啟動 typing 動畫等。
 */
export function enqueueTask(taskFn, { onStart } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ taskFn, onStart, resolve, reject });
    pump();
  });
}

// 目前佇列裡「還沒開始執行」的任務數量，不含正在執行中的那一個。
// 呼叫端通常會用 queuePendingCount() + (正在跑一個的話 +1) 來算「新任務會排第幾個」。
export function queuePendingCount() {
  return queue.length;
}

export function isProcessing() {
  return processing;
}
