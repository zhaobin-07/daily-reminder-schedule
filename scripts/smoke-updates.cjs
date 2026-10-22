// Real Electron renderer/preload/IPC smoke test. The updater is a fake: no
// network, user database, real installation, or GitHub publication is involved.
const { app, BrowserWindow, ipcMain, nativeImage, Tray } = require('electron');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('../src/db/database');
const createUpdates = require('../src/updates');
const createTrayIcon = require('../src/tray-icon');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-reminder-ui-'));
app.setPath('userData', folder);
let win, db;
const waitFor = async predicate => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Electron UI timed out');
};

app.whenReady().then(async () => {
  const icon = createTrayIcon(nativeImage);
  assert.equal(icon.isEmpty(), false);
  assert.deepEqual(icon.getSize(), { width: 32, height: 32 });
  const bitmap = icon.toBitmap();
  assert.ok(bitmap.some((value, index) => index % 4 === 3 && value === 255));
  assert.ok(bitmap.some((value, index) => index % 4 === 3 && value === 0));
  const testTray = new Tray(icon);
  assert.equal(testTray.isDestroyed(), false);
  testTray.destroy();
  console.log('Tray bitmap smoke passed: nonempty 32px icon, opaque/transparent pixels, Windows Tray creation.');
  db = await Database.create(folder);
  win = new BrowserWindow({ show: false, width: 1360, height: 900,
    webPreferences: { preload: path.resolve(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false } });
  let installs = 0, finishDownload;
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => updater.emit('update-available', {
    version: '0.1.1', releaseNotes: '<img src=x onerror=alert(1)> 测试更新说明'
  });
  updater.downloadUpdate = () => new Promise(resolve => {
    updater.emit('download-progress', { percent: 37 });
    finishDownload = () => { updater.emit('update-downloaded', { version: '0.1.1' }); resolve(); };
  });
  updater.quitAndInstall = () => { installs++; };
  const updates = createUpdates({ updater, version: '0.1.0', enabled: true,
    beforeInstall: () => db.backupForUpdate('0.1.0'),
    onState: status => win.webContents.send('update:status', status) });
  ipcMain.handle('settings:get', () => db.getSettings());
  ipcMain.handle('todos:day', (_, date) => db.getDayData(date));
  ipcMain.handle('update:state', () => updates.snapshot());
  ipcMain.handle('update:check', () => updates.check());
  ipcMain.handle('update:download', () => updates.download());
  ipcMain.handle('update:install', () => updates.install());
  const js = code => win.webContents.executeJavaScript(code);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await waitFor(() => js("!!document.querySelector('#page-updates [data-update-action=check]')"));
  await click('#nav [data-page=updates]');
  assert.equal(await js("document.querySelector('#pageTitle').textContent"), '软件更新');
  await click('#page-updates [data-update-action=check]');
  await waitFor(() => js("!!document.querySelector('[role=dialog] [data-update-action=download]')"));
  assert.equal(await js("document.querySelectorAll('[role=dialog] img').length"), 0);
  assert.ok((await js("document.querySelector('[role=dialog]').textContent")).includes('<img src=x'));
  await click('[data-update-later]');
  await click('#page-updates [data-update-action=download]');
  await waitFor(() => js("document.querySelector('progress')?.value === 37"));
  finishDownload();
  await waitFor(() => js("!!document.querySelector('[role=dialog] [data-update-action=install]')"));
  assert.equal(installs, 0);
  // A renderer reload must restore the already downloaded state.
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await waitFor(() => js("!!document.querySelector('[role=dialog] [data-update-action=install]')"));
  await js('void (window.confirm = () => false)');
  await click('[role=dialog] [data-update-action=install]');
  assert.equal(installs, 0);
  await js('void (window.confirm = () => true)');
  await click('[role=dialog] [data-update-action=install]');
  await waitFor(() => installs === 1);
  assert.equal(fs.readdirSync(path.join(folder, 'backups')).filter(name => name.endsWith('.sqlite')).length, 1);
  console.log('Electron UI smoke passed: navigation, escaped release notes, later/download/progress, reload state, confirmation, backup-before-install.');
}).then(() => finish(0)).catch(error => { console.error(error); finish(1); });

function finish(code) {
  win?.destroy();
  db?.close();
  // Only the exact temporary profile created above is eligible for cleanup.
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch { console.log(`Temporary Electron profile retained: ${folder}`); }
  app.exit(code);
}
