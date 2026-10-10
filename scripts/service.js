// 把 bot 註冊成常駐服務（pm2 + 登入時自動啟動），Windows / macOS / Linux 共用這一支。
//
// 用法（見 package.json）：
//   pnpm run service:install     啟動並註冊開機（登入）自動啟動
//   pnpm run service:logs        即時看 log（Ctrl+C 離開，不會停掉服務）
//   pnpm run service:restart     重新啟動（改完 .env 或更新程式後用）
//   pnpm run service:uninstall   停止並移除開機啟動
//
// 要做哪些步驟由 servicePlan.js 依作業系統決定，這支只負責照著執行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planService } from "./servicePlan.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = process.argv[2];

function commandExists(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0;
}

function execute(step) {
  switch (step.type) {
    case "check":
      if (commandExists(step.command)) {
        console.log(`✅ ${step.command}`);
      } else {
        console.warn(`⚠️  找不到 ${step.command}（相關功能會停用）。${step.hint}`);
      }
      return;
    case "run": {
      const result = spawnSync(step.cmd, step.args, { cwd: repoDir, stdio: "inherit" });
      if (result.error || result.status !== 0) {
        throw new Error(`執行失敗：${[step.cmd, ...step.args].join(" ")}${result.error ? `（${result.error.message}）` : ""}`);
      }
      return;
    }
    case "write":
      fs.mkdirSync(path.dirname(step.path), { recursive: true });
      fs.writeFileSync(step.path, step.content, "utf8");
      console.log(`📝 已寫入開機啟動設定：${step.path}`);
      return;
    case "remove":
      fs.rmSync(step.path, { force: true });
      console.log(`🗑️  已移除開機啟動設定：${step.path}`);
      return;
    default:
      throw new Error(`未知的步驟：${step.type}`);
  }
}

const pm2Path = path.join(repoDir, "node_modules", "pm2", "bin", "pm2");
if (!fs.existsSync(pm2Path)) {
  console.error("❌ 找不到 pm2，請先在專案資料夾執行 pnpm install");
  process.exit(1);
}

try {
  const steps = planService(action, {
    platform: process.platform,
    home: os.homedir(),
    appData: process.env.APPDATA,
    nodePath: process.execPath,
    pm2Path,
    repoDir,
    envPath: process.env.PATH || "",
  });
  for (const step of steps) execute(step);
  if (action === "install") {
    console.log("\n✅ 服務已啟動，之後登入電腦會自動在背景執行。看 log：pnpm run service:logs");
    console.log("   （之後如果換了 Node 版本或搬動專案資料夾，重跑一次 pnpm run service:install）");
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
