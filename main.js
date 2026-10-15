'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { createOszImporter } = require('./shared/osz');
const { createExportPlan, exportFolder, exportOsz, safeName } = require('./shared/exportEngine');

let mainWindow = null;
let oszImporter = null;

app.on('will-quit', () => {
  try { if (oszImporter) oszImporter.dispose(); }
  catch (error) { console.error('清理本次导入临时文件失败:', error.message); }
});

function createWindow(options = {}) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#120a20',
    title: 'osu! Cut Editor',
    show: options.show !== false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('RENDER-PROCESS-GONE', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_e, details) => {
    if (process.env.OSU_CUT_DEBUG === '1') console.log('RENDERER-CONSOLE[' + details.level + ']', details.message, 'line=' + details.lineNumber, details.sourceId);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (process.env.OSU_CUT_DEBUG === '1') console.log('DID-FINISH-LOAD');
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

if (require.main === module) {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { createWindow };

function listOsuFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (ent.name.toLowerCase().endsWith('.osu')) out.push({ name: ent.name, path: path.join(dir, ent.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function listFiles(dir) {
  const out = [];
  const walk = (d, base) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      const rel = base ? base + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(full, rel);
      else if (ent.isFile()) out.push({ name: rel, path: full });
    }
  };
  try { walk(dir, ''); } catch (e) {}
  return out;
}

ipcMain.handle('open-osu-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select .osu beatmaps',
    filters: [{ name: 'osu! beatmap', extensions: ['osu'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return { canceled: true };
  return { canceled: false, files: res.filePaths.map((p) => ({ name: path.basename(p), path: p })) };
});

ipcMain.handle('open-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select beatmap folder',
    properties: ['openDirectory']
  });
  if (res.canceled) return { canceled: true };
  const dir = res.filePaths[0];
  return { canceled: false, folder: dir, osuFiles: listOsuFiles(dir), files: listFiles(dir) };
});

ipcMain.handle('open-osz', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select .osz package',
    filters: [{ name: 'osu! beatmap package', extensions: ['osz'] }],
    properties: ['openFile']
  });
  if (res.canceled) return { canceled: true };
  const src = res.filePaths[0];
  if (!oszImporter) oszImporter = createOszImporter(app.getPath('temp'));
  return oszImporter.open(src);
});

ipcMain.handle('read-text', async (_ev, filePath) => {
  return fs.readFileSync(filePath, 'utf8');
});

ipcMain.handle('read-binary', async (_ev, filePath) => {
  return fs.readFileSync(filePath);
});

ipcMain.handle('list-folder', async (_ev, folder) => {
  return { folder, osuFiles: listOsuFiles(folder), files: listFiles(folder) };
});

ipcMain.handle('export-cut-folder', async (_ev, payload) => {
  const plan = createExportPlan(payload);
  return exportFolder(plan, payload.outputParent);
});

ipcMain.handle('export-osz', async (_ev, payload) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export .osz',
    defaultPath: safeName(payload.oszBaseName) + '.osz',
    filters: [{ name: 'osu! beatmap package', extensions: ['osz'] }]
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  return exportOsz(createExportPlan(payload), res.filePath);
});
