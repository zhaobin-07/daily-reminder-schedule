(() => {
  let current;
  let prompted = '';
  let dialog;
  const labels = {
    idle: '等待检查', unavailable: '当前运行方式不支持在线升级', checking: '正在检查新版本…',
    'not-available': '当前已是最新版本', available: '发现新版本', downloading: '正在下载更新…',
    downloaded: '更新已下载，等待安装', installing: '正在启动安装程序…', error: '更新失败，可以重试'
  };
  function content() {
    const s = current;
    return `<p>当前版本：${esc(s.currentVersion)}${s.version ? `　新版本：${esc(s.version)}` : ''}</p>
      <p role="status">${labels[s.status] || '等待检查'}${s.status === 'downloading' ? ` ${s.percent || 0}%` : ''}</p>
      ${s.message ? `<p class="todo-meta">${esc(s.message)}</p>` : ''}
      ${s.status === 'downloading' ? `<progress max="100" value="${s.percent || 0}" aria-label="下载进度"></progress>` : ''}
      ${s.releaseNotes ? `<pre class="update-notes">${esc(s.releaseNotes)}</pre>` : ''}
      <p class="todo-meta">仅程序更新需要联网。待办、提醒和设置仍保存在本机，互不共享。安装前会自动备份数据库。</p>
      <div class="form-actions">
        <button class="secondary" data-update-action="check" ${['idle', 'not-available', 'available', 'error'].includes(s.status) ? '' : 'disabled'}>检查更新</button>
        ${s.status === 'available' ? '<button class="primary" data-update-action="download">立即升级（下载）</button>' : ''}
        ${s.status === 'downloaded' ? '<button class="primary" data-update-action="install">立即重启安装</button>' : ''}
      </div>`;
  }
  function bind(container) {
    container.querySelectorAll('[data-update-action]').forEach(button => {
      button.onclick = async () => {
        const action = button.dataset.updateAction;
        if (action === 'install' && !confirm('将保存并备份已提交的数据，然后重启安装。未保存的编辑内容不会保留，确定继续吗？')) return;
        button.disabled = true;
        try {
          // Status events update the UI; invocation results are deliberately not
          // reapplied because a delayed response could overwrite a newer event.
          if (action === 'check') await api.checkForUpdates();
          if (action === 'download') await api.downloadUpdate();
          if (action === 'install') await api.installUpdate();
        } catch {
          current = { ...current, status: 'error', message: '无法连接更新服务，请稍后重试。当前数据不受影响。' };
          render();
        } finally { if (button.isConnected) button.disabled = false; }
      };
    });
  }
  function render() {
    const page = document.getElementById('page-updates');
    if (!page || !current) return;
    page.innerHTML = `<div class="card"><div class="section-head"><h2>软件更新</h2></div>${content()}</div>`;
    bind(page);
    if (dialog) {
      dialog.querySelector('[data-update-content]').innerHTML = content();
      bind(dialog);
    }
  }
  function receive(status) {
    current = status;
    render();
    if (!['available', 'downloaded'].includes(status.status)) return;
    const key = `${status.status}:${status.version}`;
    if (key === prompted) return;
    prompted = key;
    if (dialog) return;
    dialog = document.createElement('div');
    dialog.className = 'modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '软件更新');
    dialog.innerHTML = '<div class="modal-card"><div class="modal-head"><h2>软件更新</h2><button class="secondary" data-update-later>稍后</button></div><div data-update-content></div></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-update-later]').onclick = () => { dialog.remove(); dialog = null; };
    render();
    dialog.querySelector('[data-update-later]').focus();
  }
  window.initUpdates = async () => {
    // Subscribe before requesting the snapshot; don't overwrite a newer event
    // with an older state returned by the initial request.
    let receivedEvent = false;
    api.onUpdateStatus(status => { receivedEvent = true; receive(status); });
    try { const status = await api.getUpdateState(); if (!receivedEvent) receive(status); }
    catch { receive({ status: 'error', currentVersion: '', message: '无法读取更新状态，请重启程序后重试。' }); }
  };
})();
