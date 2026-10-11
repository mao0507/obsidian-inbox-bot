// Telegram long polling 掛掉（例如 409 Conflict：有另一個程式短暫用了同一個 bot token、網路斷線）時，
// Telegraf 只會讓 launch() 的 Promise 失敗、停止收訊息，但程序還活著——pm2 看起來正常，bot 卻不再回應。
// keepPolling 在失敗後等一下再重新 launch，間隔逐次加倍（上限 2 分鐘）；正常跑超過 5 分鐘才掛掉就從頭計算。

const FIRST_DELAY_MS = 10_000;
const MAX_DELAY_MS = 120_000;
const HEALTHY_RUN_MS = 5 * 60_000;

/**
 * @param {object} opts
 * @param {() => Promise<void>} opts.launch  開始收訊息；收訊息期間不會 resolve，失敗時 reject
 * @param {(err: Error, delayMs: number) => void} opts.onError
 * @param {(fn: Function, ms: number) => void} [opts.schedule]
 * @param {() => number} [opts.now]
 * @returns {{ stop: () => void }}
 */
export function keepPolling({ launch, onError, schedule = setTimeout, now = Date.now }) {
  let stopped = false;
  let failures = 0;

  async function run() {
    if (stopped) return;
    const startedAt = now();
    try {
      await launch();
    } catch (err) {
      if (stopped) return;
      if (now() - startedAt >= HEALTHY_RUN_MS) failures = 0;
      const delay = Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** failures);
      failures++;
      onError(err, delay);
      schedule(run, delay);
    }
  }

  run();
  return {
    stop() {
      stopped = true;
    },
  };
}
