import { test } from "node:test";
import assert from "node:assert/strict";
import { planService } from "../scripts/servicePlan.js";

const envs = {
  win32: {
    platform: "win32",
    home: "C:\\Users\\me",
    appData: "C:\\Users\\me\\AppData\\Roaming",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    pm2Path: "C:\\repo\\node_modules\\pm2\\bin\\pm2",
    repoDir: "C:\\repo",
    envPath: "C:\\bin",
  },
  darwin: {
    platform: "darwin",
    home: "/Users/me",
    nodePath: "/opt/homebrew/bin/node",
    pm2Path: "/repo/node_modules/pm2/bin/pm2",
    repoDir: "/repo",
    envPath: "/opt/homebrew/bin:/usr/bin",
  },
  linux: {
    platform: "linux",
    home: "/home/me",
    nodePath: "/usr/bin/node",
    pm2Path: "/repo/node_modules/pm2/bin/pm2",
    repoDir: "/repo",
    envPath: "/usr/local/bin:/usr/bin",
  },
};

const startupFile = {
  win32: "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\obsidian-inbox-bot.vbs",
  darwin: "/Users/me/Library/LaunchAgents/com.obsidian-inbox-bot.plist",
  linux: "/home/me/.config/systemd/user/obsidian-inbox-bot.service",
};

// pm2 一律用「node <pm2 bin> ...」執行（跨平台，不依賴全域安裝），這裡取出 pm2 之後的參數。
const isPm2 = (s) => s.type === "run" && /pm2[\\/]bin[\\/]pm2$/.test(s.args[0] || "");
const pm2Runs = (steps) => steps.filter(isPm2).map((s) => s.args.slice(1).join(" "));

for (const platform of Object.keys(envs)) {
  test(`${platform} install: starts app with pm2, saves, registers login startup that resurrects`, () => {
    const steps = planService("install", envs[platform]);

    assert.deepEqual(pm2Runs(steps).slice(0, 2), ["start ecosystem.config.cjs", "save"]);
    const write = steps.find((s) => s.type === "write");
    assert.equal(write.path, startupFile[platform]);
    assert.match(write.content, /resurrect/);
    assert.ok(write.content.includes(envs[platform].nodePath));
  });

  test(`${platform} uninstall: removes app and the startup entry`, () => {
    const steps = planService("uninstall", envs[platform]);
    assert.ok(pm2Runs(steps).includes("delete obsidian-inbox-bot"));
    assert.ok(steps.some((s) => s.type === "remove" && s.path === startupFile[platform]));
  });

  test(`${platform} install checks external CLIs with OS-specific hints`, () => {
    const checks = planService("install", envs[platform]).filter((s) => s.type === "check");
    assert.deepEqual(checks.map((c) => c.command), ["git", "yt-dlp", "notebooklm"]);
    const ytHint = checks.find((c) => c.command === "yt-dlp").hint;
    assert.match(ytHint, { win32: /winget/, darwin: /brew/, linux: /pipx/ }[platform]);
  });
}

test("windows startup script runs hidden (window style 0)", () => {
  const write = planService("install", envs.win32).find((s) => s.type === "write");
  assert.match(write.content, /, 0, False/);
});

test("launchd / systemd entries carry PATH so agent CLIs are found", () => {
  for (const platform of ["darwin", "linux"]) {
    const write = planService("install", envs[platform]).find((s) => s.type === "write");
    assert.ok(write.content.includes(envs[platform].envPath), platform);
  }
});

test("linux enables the systemd user unit", () => {
  const steps = planService("install", envs.linux);
  assert.ok(steps.some((s) => s.type === "run" && s.cmd === "systemctl" && s.args.join(" ") === "--user enable obsidian-inbox-bot.service"));
});

test("logs and restart are thin pm2 calls", () => {
  assert.deepEqual(pm2Runs(planService("logs", envs.linux)), ["logs obsidian-inbox-bot"]);
  assert.deepEqual(pm2Runs(planService("restart", envs.linux)), ["restart obsidian-inbox-bot"]);
});

test("unknown action is rejected", () => {
  assert.throws(() => planService("explode", envs.linux), /未知的動作/);
});
