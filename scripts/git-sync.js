// 手動觸發一次 vault 的 git 同步。用途：你直接在 Obsidian 裡編輯/搬移了筆記，
// 不想等下一次透過 bot/web 新增筆記才順便同步，就跑這支立刻推上 git。
//
// 用法：node scripts/git-sync.js
import { commitAndPush } from "../src/gitSync.js";
import { VAULT_GIT_ENABLED } from "../src/config.js";

if (!VAULT_GIT_ENABLED) {
  console.log("VAULT_GIT_REMOTE 沒有設定，沒有東西可以同步（見 .env.example 的說明）。");
  process.exit(0);
}

const result = await commitAndPush("手動同步 vault 異動");

if (result.pushed) {
  console.log("✅ 已同步到 git");
} else if (result.skipped) {
  console.log("目前沒有新的異動，不用同步。");
} else {
  console.error(`❌ 同步失敗：${result.error}`);
  process.exit(1);
}
