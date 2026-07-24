import { spawnSync } from 'node:child_process';

const cmd = process.platform === 'win32' ? 'notebooklm.exe' : 'notebooklm';
const result = spawnSync(cmd, ['login'], { stdio: 'inherit', shell: true });

if (result.error) {
  console.error(`[notebooklm-login] 找不到 notebooklm CLI，請確認 notebooklm-py 已安裝且在 PATH 內：${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
