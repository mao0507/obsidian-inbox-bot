import { test } from "node:test";
import assert from "node:assert/strict";
import { selfUpdate } from "../src/selfUpdate.js";

// 假的指令執行器：依序回應 HEAD（更新前、更新後），記錄執行過的指令
function fakeRun({ heads, changed = "", log = "" }) {
  const calls = [];
  let headIndex = 0;
  const run = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "rev-parse") return `${heads[headIndex++]}\n`;
    if (args[0] === "log") return log;
    if (args[0] === "diff") return changed;
    return "";
  };
  return { run, calls };
}

test("selfUpdate: already up to date does nothing else", async () => {
  const { run, calls } = fakeRun({ heads: ["a", "a"] });
  assert.deepEqual(await selfUpdate({ run }), { updated: false, commits: [], installed: false });
  assert.ok(!calls.some((c) => c.startsWith("pnpm")));
});

test("selfUpdate: new commits without dependency changes skip install", async () => {
  const { run, calls } = fakeRun({ heads: ["a", "b"], log: "b2 feat: y\nb1 fix: x\n", changed: "src/bot.js\nREADME.md\n" });
  assert.deepEqual(await selfUpdate({ run }), { updated: true, commits: ["b2 feat: y", "b1 fix: x"], installed: false });
  assert.ok(calls.includes("git pull --ff-only"));
  assert.ok(!calls.some((c) => c.startsWith("pnpm")));
});

test("selfUpdate: lockfile change runs a frozen install", async () => {
  const { run, calls } = fakeRun({ heads: ["a", "b"], log: "b feat\n", changed: "pnpm-lock.yaml\nsrc/x.js\n" });
  assert.equal((await selfUpdate({ run })).installed, true);
  assert.ok(calls.includes("pnpm install --frozen-lockfile"));
});

test("selfUpdate: pull failure propagates", async () => {
  const run = async (command, args) => {
    if (args[0] === "pull") throw new Error("git pull --ff-only 失敗：Not possible to fast-forward");
    return "a\n";
  };
  await assert.rejects(selfUpdate({ run }), /fast-forward/);
});
