import { test } from "node:test";
import assert from "node:assert/strict";
import { keepPolling } from "../src/reconnect.js";

// 假的時鐘與排程：schedule 記下延遲，手動觸發
function harness(results) {
  const delays = [];
  const errors = [];
  let pending = null;
  let clock = 0;
  let calls = 0;
  const launch = async () => {
    calls++;
    const r = results.shift();
    if (r?.after) clock += r.after; // 模擬「正常跑了一段時間才掛掉」
    if (r instanceof Error || r?.error) throw r.error || r;
    return new Promise(() => {}); // 正常收訊息中：永遠不結束
  };
  const ctl = keepPolling({
    launch,
    onError: (err, delay) => errors.push([err.message, delay]),
    schedule: (fn, ms) => {
      delays.push(ms);
      pending = fn;
    },
    now: () => clock,
  });
  return {
    ctl,
    delays,
    errors,
    get calls() {
      return calls;
    },
    fire: async () => {
      const fn = pending;
      pending = null;
      fn(); // 不等它：重連成功時 launch() 會一直跑下去
      await new Promise((r) => setImmediate(r));
    },
  };
}

const conflict = () => Object.assign(new Error("409: Conflict"), { response: { error_code: 409 } });

test("polling that dies is relaunched with growing backoff", async () => {
  const h = harness([conflict(), conflict(), conflict(), "ok"]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.delays, [10_000]);
  await h.fire();
  await h.fire();
  assert.deepEqual(h.delays, [10_000, 20_000, 40_000]);
  await h.fire();
  assert.equal(h.calls, 4, "fourth launch succeeds and keeps running");
  assert.equal(h.errors.length, 3);
});

test("backoff is capped and resets after a long healthy run", async () => {
  const h = harness([conflict(), conflict(), conflict(), conflict(), conflict(), conflict(), { after: 10 * 60_000, error: conflict() }]);
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 5; i++) await h.fire();
  assert.equal(Math.max(...h.delays), 120_000);

  await h.fire(); // 這次跑了 10 分鐘才掛掉
  assert.equal(h.delays.at(-1), 10_000);
});

test("stop() prevents further relaunches", async () => {
  const h = harness([conflict(), conflict()]);
  await new Promise((r) => setImmediate(r));
  h.ctl.stop();
  await h.fire();
  assert.equal(h.calls, 1);
});
