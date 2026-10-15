'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const parent = path.join(root, '.test-tmp');
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, 'electron-check-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--screenshots')) {
  env.OSU_CUT_CAPTURE_DIR = path.join(root, 'build', 'verification-' + require('../package.json').version);
}
if (process.argv.includes('--packaged')) {
  env.OSU_CUT_TEST_APP_ASAR = path.join(root, 'dist/win-unpacked/resources/app.asar');
  if (!fs.existsSync(env.OSU_CUT_TEST_APP_ASAR)) throw new Error('请先构建应用，再验证打包结果');
}
const flags = process.env.OSU_CUT_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
const child = spawn(require('electron'), [...flags, path.join(__dirname, 'electron-check.cjs'), scratch], {
  cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const timeout = setTimeout(() => { console.error('Electron check timed out'); child.kill(); }, 60000);
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('close', async (code) => {
  clearTimeout(timeout);
  process.exitCode = code === 0 ? 0 : 1;
  if (code !== 0) { console.error('Electron exit code: ' + code + '; diagnostic files retained at: ' + scratch); return; }
  if (path.dirname(path.resolve(scratch)) !== parent || !path.basename(scratch).startsWith('electron-check-')) {
    throw new Error('Unexpected cleanup path');
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 9) { console.error('Cleanup failed: ' + error.message); process.exitCode = 1; }
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});
