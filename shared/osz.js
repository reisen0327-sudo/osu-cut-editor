'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const IMPORT_PREFIX = 'osu-cut-import-';
const IMPORT_LIMITS = Object.freeze({ archiveBytes: 512 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, entries: 10000 });

function entryPath(entry) {
  const name = entry.entryName.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = name.split('/');
  if (!name || path.win32.isAbsolute(name) || parts.some((part) =>
    !part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('压缩包包含不安全或 Windows 不支持的路径：' + entry.entryName);
  }
  return name;
}

function listOsz(filePath) {
  const zip = new AdmZip(filePath);
  return { entries: zip.getEntries().map((e) => e.entryName) };
}

function extractOsz(filePath, targetDir, limits = IMPORT_LIMITS) {
  if (fs.statSync(filePath).size > limits.archiveBytes) throw new Error('压缩包超过导入大小限制');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  if (entries.length > limits.entries) throw new Error('压缩包文件数量超过导入限制');
  let total = 0;
  const destinations = new Map();
  // Validate the complete manifest before writing or decompressing any entry.
  const plans = entries.map((entry) => {
    const name = entryPath(entry), key = name.toLowerCase();
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.fileBytes || (total += size) > limits.totalBytes) {
      throw new Error('压缩包解压大小超过导入限制');
    }
    if (destinations.has(key) && !(entry.isDirectory && destinations.get(key))) {
      throw new Error('压缩包存在大小写重复或冲突的路径：' + name);
    }
    destinations.set(key, entry.isDirectory);
    return { entry, name };
  });
  for (const { name } of plans) {
    const parts = name.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      if (destinations.get(parts.slice(0, i).join('/')) === false) {
        throw new Error('压缩包文件与目录路径冲突：' + name);
      }
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const files = [];
  for (const { entry, name } of plans) {
    if (entry.isDirectory) continue;
    const root = path.resolve(targetDir), dest = path.resolve(root, ...name.split('/'));
    if (!dest.startsWith(root + path.sep)) throw new Error('拒绝写入解压目录之外');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = entry.getData();
    if (data.length !== entry.header.size) throw new Error('压缩包声明的文件大小与实际数据不符：' + name);
    fs.writeFileSync(dest, data, { flag: 'wx' });
    files.push(name);
  }
  return { targetDir, files };
}

function createOszImporter(tempRoot, limits = IMPORT_LIMITS) {
  const parent = path.resolve(tempRoot), owned = new Set();
  const remove = (dir) => {
    if (!owned.has(dir) || path.dirname(dir) !== parent || !path.basename(dir).startsWith(IMPORT_PREFIX)) {
      throw new Error('拒绝清理非本次导入的目录');
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    owned.delete(dir);
  };
  return {
    open(filePath) {
      const dir = fs.mkdtempSync(path.join(parent, IMPORT_PREFIX));
      owned.add(dir);
      try {
        const info = extractOsz(filePath, dir, limits);
        const files = info.files.map((name) => ({ name, path: path.join(dir, ...name.split('/')) }));
        const osuFiles = files.filter((file) => /\.osu$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name));
        if (!osuFiles.length) throw new Error('压缩包中没有 .osu 谱面文件');
        return { canceled: false, folder: dir, oszPath: filePath, files, osuFiles, entries: info.files };
      } catch (error) {
        remove(dir);
        throw error;
      }
    },
    dispose() { for (const dir of [...owned]) remove(dir); }
  };
}

function writeOsz(sourceDir, destPath, options) {
  const opts = options || {};
  const excludeStoryboard = opts.excludeStoryboard !== false;
  const zip = new AdmZip();
  const addFile = (relPath, data) => {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').some((seg) => seg === '..')) {
      throw new Error('Unsafe zip path: ' + relPath);
    }
    zip.addFile(normalized, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
  };
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = base ? base + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        if (excludeStoryboard && entry.name.toLowerCase().endsWith('.osb')) continue;
        if (typeof opts.filter === 'function' && !opts.filter(rel)) continue;
        addFile(rel, fs.readFileSync(full));
      }
    }
  };
  walk(sourceDir, '');
  if (opts.extraFiles) {
    for (const [relPath, data] of Object.entries(opts.extraFiles)) addFile(relPath, data);
  }
  zip.writeZip(destPath);
  return destPath;
}

module.exports = { listOsz, extractOsz, writeOsz, createOszImporter, IMPORT_LIMITS };
