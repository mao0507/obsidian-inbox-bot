import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../src/taskQueue.js";

// 可以從外部控制何時結束的任務
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

test("same lane runs tasks one at a time, in order", async () => {
  const lane = createTaskQueue();
  const first = deferred();
  const log = [];

  const a = lane.enqueue(async () => (log.push("a start"), await first.promise, log.push("a end"), "A"));
  const b = lane.enqueue(async () => (log.push("b start"), "B"));

  await Promise.resolve();
  assert.deepEqual(log, ["a start"]);
  assert.equal(lane.size(), 2);

  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ["A", "B"]);
  assert.deepEqual(log, ["a start", "a end", "b start"]);
  assert.equal(lane.size(), 0);
});

test("different lanes run in parallel", async () => {
  const intake = createTaskQueue();
  const research = createTaskQueue();
  const longResearch = deferred();

  const r = research.enqueue(() => longResearch.promise);
  const done = await intake.enqueue(async () => "intake done"); // 研究還沒結束，一般內容照樣完成

  assert.equal(done, "intake done");
  assert.equal(research.size(), 1);
  longResearch.resolve("research done");
  assert.equal(await r, "research done");
});

test("a failing task rejects its own promise and does not block the next", async () => {
  const lane = createTaskQueue();
  const failed = lane.enqueue(async () => {
    throw new Error("boom");
  });
  const next = lane.enqueue(async () => "ok");

  await assert.rejects(failed, /boom/);
  assert.equal(await next, "ok");
});

test("onStart fires when the task actually starts, not when queued", async () => {
  const lane = createTaskQueue();
  const first = deferred();
  const started = [];

  lane.enqueue(() => first.promise, { onStart: () => started.push("a") });
  const b = lane.enqueue(async () => {}, { onStart: () => started.push("b") });

  await Promise.resolve();
  assert.deepEqual(started, ["a"]);
  first.resolve();
  await b;
  assert.deepEqual(started, ["a", "b"]);
});
