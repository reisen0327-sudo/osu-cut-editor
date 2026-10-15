'use strict';

const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');
const AdmZip = require('adm-zip');
const { parseOsu, getKv } = require('../shared/osuParser');
const root = path.resolve(__dirname, '..');
const scratch = path.resolve(process.argv.at(-1));
assert.equal(path.dirname(scratch), path.join(root, '.test-tmp'));
assert.ok(path.basename(scratch).startsWith('electron-check-'));
for (const name of ['profile', 'imports', 'source', 'output']) fs.mkdirSync(path.join(scratch, name));
app.setPath('userData', path.join(scratch, 'profile'));
app.setPath('sessionData', path.join(scratch, 'profile'));
app.setPath('temp', path.join(scratch, 'imports'));
app.disableHardwareAcceleration();
const source = path.join(scratch, 'source'), output = path.join(scratch, 'output');
const standardName = 'Cut Test - osu-cut-editor [Normal].osu';
const maniaName = 'Mania Test - osu-cut-editor [4K].osu';
for (const name of [standardName, maniaName, 'audio.wav']) fs.copyFileSync(path.join(root, 'sample', name), path.join(source, name));
fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(source, 'bg.jpg'));
fs.mkdirSync(path.join(source, 'sounds'));
fs.copyFileSync(path.join(root, 'sample/audio.wav'), path.join(source, 'sounds/custom.wav'));
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const beforeAudioHash = hash(path.join(source, 'audio.wav'));
const beforeMapHash = hash(path.join(source, standardName));
const zipPath = path.join(output, 'cut.osz');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: zipPath });
let window;
let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
const evaluate = (body, args = {}) => window.webContents.executeJavaScript(
  '(async (args) => {' + body + '})(' + JSON.stringify(args) + ')', true);
const load = (name) => evaluate('await loadOsuPath(args.file, null, args.output); return {mode:state.mode, count:state.objects.length, duration:state.audioBuffer && state.audioBuffer.duration};',
  { file: path.join(source, name), output });

app.whenReady().then(async () => {
  const mainPath = process.env.OSU_CUT_TEST_APP_ASAR ? path.join(process.env.OSU_CUT_TEST_APP_ASAR, 'main.js') : path.join(root, 'main.js');
  window = require(mainPath).createWindow({ show: false });
  window.webContents.setAudioMuted(true);
  await new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve);
    window.webContents.once('did-fail-load', (_event, code, desc) => reject(new Error(code + ': ' + desc)));
  });
  await evaluate('window.checkAlerts=[]; window.alert=(message)=>window.checkAlerts.push(message);');

  await check('actual renderer and Web Audio decode standard sample', async () => {
    const result = await load(standardName);
    assert.deepEqual(result, { mode: 0, count: 7, duration: 8 });
  });
  await check('standard cut highlighting includes a circle at the start and excludes the end', async () => {
    const result = await evaluate(`
      $('cut-start').value='1000'; $('cut-end').value='1500'; syncSelectionFromInputs();
      const selected=[]; const originalArc=pfCtx.arc, originalFill=pfCtx.fill; let x=0,y=0;
      pfCtx.arc=function(a,b,...rest){x=a;y=b;return originalArc.call(this,a,b,...rest);};
      pfCtx.fill=function(...args){if(this.fillStyle.includes('255, 60, 90')) selected.push([x,y]);return originalFill.apply(this,args);};
      try { drawPlayfield(); } finally { pfCtx.arc=originalArc; pfCtx.fill=originalFill; }
      const point=state.objects.find(o=>o.start===1000).obj, tr=pfTransform();
      return {selected,expected:[tr.ox+point.x*tr.scale,tr.oy+point.y*tr.scale]};
    `);
    assert.deepEqual(result.selected, [result.expected]);
  });
  await check('fallback audio extension is resolved only in the referenced directory', async () => {
    const result = await evaluate(`
      return [await findAudio(args.source,'audio.mp3'),await findAudio(args.source,'missing/custom.mp3')];
    `, { source });
    assert.deepEqual(result, [path.join(source, 'audio.wav'), null]);
  });
  await check('background images still load with browser web security enabled', async () => {
    const result = await evaluate(`
      for(let i=0;i<50 && !state.backgroundImage;i++) await new Promise(resolve=>setTimeout(resolve,20));
      return !!state.backgroundImage && state.backgroundImage.naturalWidth>0;
    `);
    assert.equal(result, true);
    assert.equal(window.webContents.getLastWebPreferences().webSecurity, true);
  });
  await check('corrupt OSZ import reports an error and preserves the current edit', async () => {
    const corrupt = path.join(output, 'invalid.osz'); fs.writeFileSync(corrupt, 'invalid ZIP');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [corrupt] });
    const result = await evaluate(`
      const before=captureSnapshot(); await runImport('open-osz');
      return {same:state.text===before.text && state.audioBuffer===before.audioBuffer,message:checkAlerts.at(-1)};
    `);
    assert.equal(result.same, true); assert.match(result.message, /导入失败/);
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'imports')), []);
  });
  await check('reverse mouse selection and subsequent input edits use the latest range', async () => {
    const result = await evaluate(`
      const rect=timeline.getBoundingClientRect();
      timeline.dispatchEvent(new MouseEvent('mousedown',{clientX:rect.left+timeToX(2000)}));
      timeline.dispatchEvent(new MouseEvent('mousemove',{clientX:rect.left+timeToX(1000)}));
      window.dispatchEvent(new MouseEvent('mouseup'));
      const drag=currentSelectionRange();
      $('cut-start').value='2500'; $('cut-start').dispatchEvent(new Event('input'));
      $('cut-end').value='5500'; $('cut-end').dispatchEvent(new Event('input'));
      $('btn-select-range').click();
      const enabled=!$('btn-cut').disabled;
      $('btn-cut').click();
      return {drag,enabled,times:state.objects.map(o=>o.start),duration:state.audioBuffer.duration};
    `);
    assert.deepEqual(result, { drag: [1000, 2000], enabled: true, times: [1000, 1500, 2000, 3000, 4000], duration: 5 });
  });
  await check('undo, redo and restore original update audio and map together', async () => {
    const result = await evaluate(`
      $('btn-undo').click(); const undone=[state.audioBuffer.duration,state.objects.length,state.edited];
      $('btn-redo').click(); const redone=[state.audioBuffer.duration,state.objects.length,state.edited];
      $('btn-reset').click();
      return {undone,redone,reset:[state.audioBuffer.duration,state.objects.length,state.edited]};
    `);
    assert.deepEqual(result, { undone: [8, 7, false], redone: [5, 5, true], reset: [8, 7, false] });
  });
  await check('audio allocation failure retains the current map, audio and undo history', async () => {
    const result = await evaluate(`
      const before=captureSnapshot(), undoCount=state.undo.length;
      const originalCreate=state.audioContext.createBuffer;
      state.audioContext.createBuffer=()=>{throw new Error('injected allocation failure');};
      $('cut-start').value='2500'; $('cut-end').value='5500';
      try { doCut(); } finally { state.audioContext.createBuffer=originalCreate; }
      return {same:state.text===before.text && state.audioBuffer===before.audioBuffer,
        sameHistory:state.undo.length===undoCount,message:checkAlerts.at(-1)};
    `);
    assert.equal(result.same, true); assert.equal(result.sameHistory, true);
    assert.match(result.message, /injected allocation failure/);
  });
  await check('whole-audio cut is rejected before state changes', async () => {
    const result = await evaluate(`
      const before=captureSnapshot(); $('cut-start').value='0'; $('cut-end').value='8000'; doCut();
      return {same:state.text===before.text && state.audioBuffer===before.audioBuffer,message:checkAlerts.at(-1)};
    `);
    assert.equal(result.same, true); assert.match(result.message, /不能删除整段/);
  });
  await check('wheel moves forward and backward from exact beat positions', async () => {
    const result = await evaluate(`
      seekTo(1000); timeline.dispatchEvent(new WheelEvent('wheel',{deltaY:1,cancelable:true}));
      const forward=state.playheadMs;
      timeline.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,cancelable:true}));
      return [forward,state.playheadMs];
    `);
    assert.deepEqual(result, [1125, 1000]);
  });
  await check('mania cut handles the start boundary and crossing holds', async () => {
    await load(maniaName);
    const result = await evaluate(`
      $('cut-start').value='2500'; $('cut-end').value='5500'; doCut();
      return {mode:state.mode,times:state.objects.map(o=>o.start),duration:state.audioBuffer.duration};
    `);
    assert.deepEqual(result, { mode: 3, times: [1000, 1500, 4000], duration: 5 });
  });
  await check('folder export traverses real IPC and copies background and custom samples', async () => {
    await evaluate('await exportToFolder();');
    const dirs = fs.readdirSync(output, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(dirs.length, 1);
    const dir = path.join(output, dirs[0].name);
    assert.equal(hash(path.join(dir, 'bg.jpg')), hash(path.join(source, 'bg.jpg')));
    assert.equal(hash(path.join(dir, 'sounds/custom.wav')), hash(path.join(source, 'sounds/custom.wav')));
    const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith('.osu'))), 'utf8');
    assert.equal(getKv(parseOsu(text), 'Metadata', 'BeatmapID'), '0');
    const wav = fs.readFileSync(path.join(dir, getKv(parseOsu(text), 'General', 'AudioFilename')));
    assert.equal(wav.readUInt32LE(40) / wav.readUInt32LE(28), 5);
  });
  await check('repeated folder export leaves source assets and first result intact', async () => {
    await evaluate('await exportToFolder();');
    assert.equal(fs.readdirSync(output, { withFileTypes: true }).filter((e) => e.isDirectory()).length, 2);
    assert.equal(hash(path.join(source, 'audio.wav')), beforeAudioHash);
    assert.equal(hash(path.join(source, standardName)), beforeMapHash);
  });
  await check('OSZ export through IPC includes the shortened WAV and resource files', async () => {
    await evaluate('await exportToOsz();');
    const zip = new AdmZip(zipPath);
    assert.ok(zip.getEntry('bg.jpg') && zip.getEntry('sounds/custom.wav'));
    const name = zip.getEntries().find((e) => e.entryName.endsWith('.osu')).entryName;
    const parsed = parseOsu(zip.readAsText(name));
    const audio = zip.readFile(getKv(parsed, 'General', 'AudioFilename'));
    assert.equal(audio.readUInt32LE(40) / audio.readUInt32LE(28), 5);
  });
  await check('existing archive remains byte-identical after a rejected export', async () => {
    const before = hash(zipPath);
    const message = await evaluate('await exportToOsz(); return checkAlerts.at(-1);');
    assert.match(message, /目标文件已存在/);
    assert.equal(hash(zipPath), before);
  });
  await check('OSZ import then folder export copies assets out of the extraction directory', async () => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [zipPath] });
    const result = await evaluate(`
      const info=await ipcRenderer.invoke('open-osz');
      await loadOsuPath(info.osuFiles[0].path,info.folder,args.output);
      $('cut-start').value='100'; $('cut-end').value='200'; doCut();
      await exportToFolder();
      return {duration:state.audioBuffer.duration,source:state.folder};
    `, { output });
    assert.ok(Math.abs(result.duration - 4.9) < 0.0001);
    assert.ok(result.source.startsWith(path.join(scratch, 'imports') + path.sep));
    const dirs = fs.readdirSync(output, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(dirs.length, 3);
    for (const dir of dirs) assert.ok(fs.existsSync(path.join(output, dir.name, 'bg.jpg')));
  });
  await check('overlapping loads commit only the latest selected map', async () => {
    const result = await evaluate(`
      await Promise.all([loadOsuPath(args.a,null,args.output),loadOsuPath(args.b,null,args.output)]);
      return {mode:state.mode,path:state.osuPath,history:state.undo.length,duration:state.audioBuffer.duration};
    `, { a: path.join(source, standardName), b: path.join(source, maniaName), output });
    assert.deepEqual(result, { mode: 3, path: path.join(source, maniaName), history: 0, duration: 8 });
  });

  await check('timestamp and millisecond fields convert in both directions, including clipboard colon format', async () => {
    const result = await evaluate(`
      $('cut-start-time').value='00:49.809'; $('cut-start-time').dispatchEvent(new Event('input'));
      const copied=$('cut-start').value;
      $('cut-start').value='1250.5'; $('cut-start').dispatchEvent(new Event('input'));
      const fractional=$('cut-start-time').value;
      $('cut-end-time').value='00:03:250'; $('cut-end-time').dispatchEvent(new Event('input'));
      return {copied,fractional,end:$('cut-end').value,range:currentSelectionRange()};
    `);
    assert.deepEqual(result, { copied: '49809', fractional: '00:01.2505', end: '3250', range: [1250.5, 3250] });
  });
  await check('invalid timestamp disables Cut and cannot reuse a stale valid position', async () => {
    const result = await evaluate(`
      const before=state.text;
      $('cut-start-time').value='00:61.000'; $('cut-start-time').dispatchEvent(new Event('input'));
      const disabled=$('btn-cut').disabled, counterpart=$('cut-start').value;
      doCut();
      return {disabled,counterpart,unchanged:state.text===before,invalid:$('cut-start-time').getAttribute('aria-invalid')};
    `);
    assert.deepEqual(result, { disabled: true, counterpart: '', unchanged: true, invalid: 'true' });
  });
  await check('cutting with two formatted timestamps produces the same map and audio as milliseconds', async () => {
    const result = await evaluate(`
      $('cut-start-time').value='00:02.500'; $('cut-start-time').dispatchEvent(new Event('input'));
      $('cut-end-time').value='00:05.500'; $('cut-end-time').dispatchEvent(new Event('input'));
      $('btn-cut').click();
      return {duration:state.audioBuffer.duration,times:state.objects.map(o=>o.start),reset:$('cut-start-time').value};
    `);
    assert.deepEqual(result, { duration: 5, times: [1000, 1500, 4000], reset: '00:00.000' });
  });
  await check('anchors and mouse selections update both time formats', async () => {
    await load(maniaName);
    const result = await evaluate(`
      seekTo(1500); $('btn-snap-to-start').click();
      seekTo(3500); $('btn-snap-to-end').click();
      const anchors=[$('cut-start-time').value,$('cut-end-time').value];
      const rect=timeline.getBoundingClientRect();
      timeline.dispatchEvent(new MouseEvent('mousedown',{clientX:rect.left+timeToX(2500)}));
      timeline.dispatchEvent(new MouseEvent('mousemove',{clientX:rect.left+timeToX(5500)}));
      window.dispatchEvent(new MouseEvent('mouseup'));
      return {anchors,drag:[$('cut-start-time').value,$('cut-end-time').value]};
    `);
    assert.deepEqual(result, { anchors: ['00:01.500', '00:03.500'], drag: ['00:02.500', '00:05.500'] });
  });
  await check('continuous scroll speed changes leave audio playback and playback rate unchanged', async () => {
    const result = await evaluate(`
      seekTo(1800); playPause();
      const source=state.audioSource, audio=state.audioBuffer;
      const values=[];
      for (const speed of [0.5,1.37,3.25,8]) {
        $('mania-speed').value=speed; $('mania-speed').dispatchEvent(new Event('input'));
        values.push(state.maniaSpeed);
      }
      const same=state.audioSource===source && state.audioBuffer===audio && state.playing;
      const rate=state.audioSource.playbackRate.value;
      stopPlayback();
      $('mania-speed').value='2'; $('mania-speed').dispatchEvent(new Event('input'));
      return {values,same,rate};
    `);
    assert.deepEqual(result, { values: [0.5, 1.37, 3.25, 8], same: true, rate: 1 });
  });

  // A dense, non-overlapping LN fixture exercises actual canvas drawing at multiple sizes.
  const template = fs.readFileSync(path.join(source, maniaName), 'utf8').replace(/^0,0,"bg\.jpg".*\r?\n/gm, '');
  const denseNotes = [];
  for (let lane = 0; lane < 4; lane++) {
    let start = 750 + lane * 125, i = 0;
    while (start < 7000) {
      const end = start + [250, 500, 125, 375][i % 4];
      denseNotes.push(`${64 + lane * 128},192,${start},128,0,${end}:0:0:0:0:`);
      start = end + (i++ % 3 ? 125 : 31.25);
    }
  }
  const densePath = path.join(source, 'Dense LN.osu');
  fs.writeFileSync(densePath, template.split('[HitObjects]')[0].replace('Title:Mania Test', 'Title:Dense LN Review') + '[HitObjects]\n' + denseNotes.join('\n'));
  await evaluate(`
    showFileList([{name:'Dense LN Review [4K].osu',path:args.file}],null,args.output);
    await loadOsuPath(args.file,null,args.output); seekTo(1800);
    $('cut-start-time').value='00:02.500'; $('cut-start-time').dispatchEvent(new Event('input'));
    $('cut-end-time').value='00:03.250'; $('cut-end-time').dispatchEvent(new Event('input'));
  `, { file: densePath, output });
  const capture = async (name) => {
    if (!process.env.OSU_CUT_CAPTURE_DIR) return;
    const dir = path.resolve(process.env.OSU_CUT_CAPTURE_DIR);
    assert.equal(path.dirname(dir), path.join(root, 'build'));
    assert.ok(path.basename(dir).startsWith('verification-'));
    fs.mkdirSync(dir, { recursive: true });
    await evaluate('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
    fs.writeFileSync(path.join(dir, name + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  await check('dense LN canvas and revised controls fit normal and minimum window sizes', async () => {
    for (const [width, height, name] of [[1440, 900, 'mania-4k-default'], [1100, 700, 'mania-4k-small']]) {
      window.setSize(width, height);
      const result = await evaluate(`
        resizeTimeline(); drawAll();
        const canvas=playfield.getBoundingClientRect();
        const controls=[...document.querySelectorAll('.time-grid input')];
        const pane=$('side-pane').getBoundingClientRect();
        const cut=$('btn-cut').getBoundingClientRect();
        return {subtitle:!!document.querySelector('.subtitle'),overflow:document.documentElement.scrollWidth>innerWidth,
          fit:controls.every(input=>{const r=input.getBoundingClientRect();return r.left>=pane.left && r.right<=pane.right;}),
          cutVisible:cut.top>=pane.top && cut.bottom<=pane.bottom,
          canvasWidth:canvas.width,canvasHeight:canvas.height};
      `);
      assert.equal(result.subtitle, false); assert.equal(result.overflow, false); assert.equal(result.fit, true);
      assert.ok(result.canvasWidth > 500 && result.canvasHeight > 300);
      if (height === 900) assert.equal(result.cutVisible, true);
      await capture(name);
    }
    window.setSize(1440, 900);
    for (const [speed, name] of [[0.5, 'mania-4k-slow'], [8, 'mania-4k-fast']]) {
      await evaluate("resizeTimeline(); $('mania-speed').value=args.speed; $('mania-speed').dispatchEvent(new Event('input'));", { speed });
      await capture(name);
    }
  });

  await check('7K lanes and long notes render after changing the loaded key count', async () => {
    const sevenPath = path.join(source, 'Dense LN 7K.osu');
    const notes = [];
    for (let lane = 0; lane < 7; lane++) {
      for (let start = 750 + lane * 75; start < 7000; start += 625) {
        notes.push(`${Math.floor((lane + 0.5) * 512 / 7)},192,${start},128,0,${start + 500}:0:0:0:0:`);
      }
    }
    fs.writeFileSync(sevenPath, template.split('[HitObjects]')[0].replace('CircleSize:4', 'CircleSize:7')
      .replace('Title:Mania Test', 'Title:Dense LN Review').replace('Version:4K', 'Version:7K') + '[HitObjects]\n' + notes.join('\n'));
    const result = await evaluate(`
      showFileList([{name:'Dense LN Review [7K].osu',path:args.file}],null,args.output);
      await loadOsuPath(args.file,null,args.output); seekTo(1800);
      $('mania-speed').value='2'; $('mania-speed').dispatchEvent(new Event('input'));
      return {keys:maniaKeys(),notes:state.objects.length};
    `, { file: sevenPath, output });
    assert.equal(result.keys, 7); assert.equal(result.notes, notes.length);
    await capture('mania-7k-default');
  });

  app.once('will-quit', () => {
    try {
      assert.deepEqual(fs.readdirSync(path.join(scratch, 'imports')), []);
      console.log('PASS normal quit cleans up this session\'s OSZ extraction directories');
      console.log('Electron integration checks passed: ' + (count + 1));
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
  app.quit();
}).catch((error) => {
  console.error(error.stack || error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
