// 記憶體內 FIFO 任務佇列，每條 lane 的 concurrency 固定是 1（同一條 lane 同一時間只跑一個任務），
// 不同 lane 之間互不影響、可以同時跑。bot 用兩條：一般內容一條、/notebook 研究一條——
// 研究可能跑半小時，不該擋住一般收件；一般收件一次一個，也避免多筆同時寫 vault / git commit 互搶。
//
// 純記憶體實作，bot process 重啟的話佇列會清空——這支程式本來就假設「開著才會動」。
export function createTaskQueue() {
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
        job.resolve(await job.taskFn());
      } catch (err) {
        job.reject(err);
      } finally {
        processing = false;
        pump();
      }
    })();
  }

  return {
    /**
     * 把一個非同步任務加進這條 lane，回傳的 Promise 等真正輪到它執行完（成功或失敗）才 resolve/reject。
     * @param {() => Promise<any>} taskFn
     * @param {{ onStart?: () => Promise<void>|void }} [options] onStart：輪到它、真正開始執行時呼叫
     */
    enqueue(taskFn, { onStart } = {}) {
      return new Promise((resolve, reject) => {
        queue.push({ taskFn, onStart, resolve, reject });
        pump();
      });
    },

    /** 這條 lane 目前的任務數（排隊中 + 執行中），新任務會排在第 size() + 1 個。 */
    size() {
      return queue.length + (processing ? 1 : 0);
    },
  };
}
