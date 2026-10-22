// Keep update state in the main process so reloading a page cannot lose progress.
function createUpdates({ updater, version, enabled, beforeInstall, onState }) {
  let state = { status: enabled ? 'idle' : 'unavailable', currentVersion: version,
    message: enabled ? '启动后自动检查更新，也可以手动检查。' : '仅 Windows 安装版支持在线升级，开发模式和便携版不检查更新。' };
  let busy = false;
  const snapshot = () => ({ ...state });
  const change = (status, details = {}) => {
    state = { ...state, status, message: '', ...details };
    onState(snapshot());
  };
  const notes = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(item => item.note || '').filter(Boolean).join('\n') : '';

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // Do not log GitHub request headers or URLs containing temporary download tokens.
  updater.logger = null;
  updater.on('update-available', info => change('available', {
    version: info.version, releaseNotes: notes(info.releaseNotes), percent: 0
  }));
  updater.on('update-not-available', () => change('not-available', { version: '', releaseNotes: '' }));
  updater.on('download-progress', progress => change('downloading', {
    percent: Math.min(100, Math.max(0, Math.round(progress.percent || 0)))
  }));
  updater.on('update-downloaded', info => change('downloaded', { version: info.version, percent: 100 }));
  updater.on('error', () => change('error', {
    message: '更新检查或下载失败，请检查网络、GitHub 访问及正式 Release 文件是否完整。可以稍后重试，当前数据不受影响。'
  }));

  return {
    snapshot,
    async check() {
      if (!enabled || busy || ['downloaded', 'installing'].includes(state.status)) return snapshot();
      busy = true;
      change('checking', { version: '', releaseNotes: '' });
      try { await updater.checkForUpdates(); }
      catch { change('error', { message: '无法检查更新，请确认网络及 GitHub 访问正常，且仓库已有正式版本。' }); }
      finally { busy = false; }
      return snapshot();
    },
    async download() {
      if (!enabled || busy || state.status !== 'available') return snapshot();
      busy = true;
      change('downloading', { percent: 0 });
      try { await updater.downloadUpdate(); }
      catch { change('error', { message: '更新下载或校验失败，未安装任何更新。请检查网络后重新检查更新。' }); }
      finally { busy = false; }
      return snapshot();
    },
    install() {
      if (!enabled || busy || state.status !== 'downloaded') return snapshot();
      busy = true;
      try {
        beforeInstall();
        change('installing');
        updater.quitAndInstall(false, true);
      } catch {
        change('downloaded', { message: '保存数据、创建备份或启动安装失败，已取消本次安装。请检查磁盘空间与写入权限后重试。' });
      } finally { busy = false; }
      return snapshot();
    }
  };
}

module.exports = createUpdates;
