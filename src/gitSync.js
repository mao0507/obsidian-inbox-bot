import { VAULT_PATH, VAULT_GIT_REMOTE, VAULT_GIT_BRANCH } from "./config.js";
import { createGitSync } from "./gitSyncFactory.js";

const DEFAULT_GITIGNORE = `# Obsidian 本機狀態檔，跟裝置有關，不用同步
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.trash/

# 系統雜項檔案
.DS_Store
Thumbs.db
`;

const vaultGitSync = createGitSync({
  repoPath: VAULT_PATH,
  remoteUrl: VAULT_GIT_REMOTE,
  branch: VAULT_GIT_BRANCH,
  label: "git-sync",
  defaultGitignore: DEFAULT_GITIGNORE,
});

/**
 * 把 vault 目前所有異動（新增、修改、搬移、刪除）commit 並 push 到 remote。
 * 沒有設定 VAULT_GIT_REMOTE 時直接跳過（回傳 attempted:false），不影響任何行為。
 * 任何一步失敗都不會丟出例外，回傳結果讓呼叫端自己決定要不要顯示同步失敗訊息。
 */
export const commitAndPush = vaultGitSync.commitAndPush;
