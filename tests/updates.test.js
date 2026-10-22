const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const createUpdates = require('../src/updates');
const pkg = require('../package.json');

function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0, downloads = 0, installs = 0, backups = 0;
  updater.checkForUpdates = async () => { checks++; updater.emit('update-available', { version: '0.1.1', releaseNotes: [{ note: '<b>新增功能</b>' }] }); };
  updater.downloadUpdate = async () => { downloads++; updater.emit('download-progress', { percent: 42.5 }); updater.emit('update-downloaded', { version: '0.1.1' }); };
  updater.quitAndInstall = (silent, runAfter) => { assert.equal(silent, false); assert.equal(runAfter, true); assert.ok(backups > 0); installs++; };
  const events = [];
  const controller = createUpdates({ updater, version: '0.1.0', enabled: true,
    beforeInstall: () => { backups++; }, onState: value => events.push(value), ...options });
  return { updater, controller, events, counts: () => ({ checks, downloads, installs, backups }) };
}

test('update check never automatically downloads or installs, including on app quit', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal(f.updater.allowPrerelease, false);
  assert.equal((await f.controller.check()).status, 'available');
  assert.deepEqual(f.counts(), { checks: 1, downloads: 0, installs: 0, backups: 0 });
  assert.equal(f.controller.snapshot().releaseNotes, '<b>新增功能</b>');
});

test('explicit download reports progress; install backs up first and cannot run twice', async () => {
  const f = fixture();
  f.controller.install();
  await f.controller.download();
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().downloads, 0);
  await f.controller.check();
  await f.controller.download();
  assert.ok(f.events.some(item => item.status === 'downloading' && item.percent === 43));
  assert.equal(f.controller.snapshot().status, 'downloaded');
  await f.controller.check(); // must not discard a downloaded update
  f.controller.install();
  f.controller.install();
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1, installs: 1, backups: 1 });
});

test('development and portable mode never use network or install', async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.controller.check()).status, 'unavailable');
  await f.controller.download();
  f.controller.install();
  assert.deepEqual(f.counts(), { checks: 0, downloads: 0, installs: 0, backups: 0 });
});

test('network failure is recoverable and does not expose server response details', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('secret request header'); };
  assert.equal((await f.controller.check()).status, 'error');
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes('secret'));
  f.updater.checkForUpdates = async () => f.updater.emit('update-not-available', { version: '0.1.0' });
  assert.equal((await f.controller.check()).status, 'not-available');
});

test('failed download or checksum verification never allows installation', async () => {
  const f = fixture();
  await f.controller.check();
  f.updater.downloadUpdate = async () => { f.updater.emit('error', new Error('checksum mismatch')); throw new Error('checksum mismatch'); };
  assert.equal((await f.controller.download()).status, 'error');
  f.controller.install();
  assert.equal(f.counts().installs, 0);
});

test('backup failure blocks installation and preserves the downloaded update for retry', async () => {
  const f = fixture({ beforeInstall: () => { throw new Error('disk full'); } });
  await f.controller.check();
  await f.controller.download();
  assert.equal(f.controller.install().status, 'downloaded');
  assert.ok(f.controller.snapshot().message.includes('取消'));
  assert.equal(f.counts().installs, 0);
});

test('double-clicking check or download does not create parallel requests', async () => {
  const f = fixture();
  let finish;
  let checks = 0;
  f.updater.checkForUpdates = () => { checks++; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.controller.check();
  await f.controller.check();
  assert.equal(checks, 1);
  f.updater.emit('update-available', { version: '0.1.1' });
  finish();
  await pending;
  let downloads = 0;
  f.updater.downloadUpdate = () => { downloads++; return new Promise(resolve => { finish = resolve; }); };
  const downloading = f.controller.download();
  await f.controller.download();
  f.controller.install();
  assert.equal(downloads, 1);
  assert.equal(f.counts().installs, 0);
  f.updater.emit('update-downloaded', { version: '0.1.1' });
  finish();
  await downloading;
});

test('release config uses the correct GitHub repository and distinct NSIS/portable filenames', () => {
  assert.deepEqual(pkg.build.publish[0], { provider: 'github', owner: 'zhaobin-07', repo: 'daily-reminder-schedule', private: false, releaseType: 'release' });
  assert.notEqual(pkg.build.nsis.artifactName, pkg.build.portable.artifactName);
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.ok(pkg.scripts.dist.includes('--publish never'));
});
