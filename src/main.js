const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const Database = require('./db/database');
const createUpdates = require('./updates');
const createTrayIcon = require('./tray-icon');

let win;
let tray;
let db;
let reminderTimer;
let updates;
let updateTimer;

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f4f7fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    console.log('应用页面加载完成');
    if (updates.snapshot().status !== 'unavailable') {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(() => updates.check(), 5000);
    }
  });
  win.webContents.on('render-process-gone', (_, details) => console.error('页面进程异常退出', details));
  win.on('close', event => {
    if (app.isQuitting) return;
    event.preventDefault();
    win.hide();
  });
}

function showReminder(reminder) {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({
    title: reminder.title || '重要提醒',
    body: reminder.body || '有一条提醒需要处理',
    urgency: reminder.important ? 'critical' : 'normal',
    silent: false
  });
  notification.on('click', () => { if (win) { win.show(); win.focus(); } });
  notification.show();
  return true;
}

function checkReminders() {
  if (!db || !db.getSetting('notificationsEnabled', true)) return;
  const due = db.getDueReminders(new Date());
  due.forEach(reminder => { showReminder(reminder); db.markReminderTriggered(reminder.id); });
}

function createTray() {
  const icon = createTrayIcon(nativeImage);
  tray = new Tray(icon);
  tray.setToolTip('每日提醒与日程');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开每日提醒与日程', click: () => { win.show(); win.focus(); } },
    { label: '退出程序', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { win.show(); win.focus(); });
}

function registerIpc() {
  ipcMain.handle('todos:day', (_, date) => db.getDayData(date));
  ipcMain.handle('todos:range', (_, from, to) => db.getTodosInRange(from, to));
  ipcMain.handle('todos:overdue', (_, today, time) => db.getOverdueTodos(today, time));
  ipcMain.handle('todos:move', (_, id, date) => db.moveTodo(id, date));
  ipcMain.handle('history:search', (_, query) => db.searchHistory(query));
  ipcMain.handle('todos:save', (_, payload, scope) => db.saveTodo(payload, scope));
  ipcMain.handle('todos:delete', (_, id, scope) => db.deleteTodo(id, scope));
  ipcMain.handle('todos:complete', (_, id, completed) => db.setTodoCompleted(id, completed));
  ipcMain.handle('reminders:save', (_, payload) => db.saveReminder(payload));
  ipcMain.handle('reminders:list', () => db.listReminders());
  ipcMain.handle('reminders:complete', (_, id, completed) => db.setReminderCompleted(id, completed));
  ipcMain.handle('reminders:snooze', (_, id, minutes) => db.snoozeReminder(id, minutes));
  ipcMain.handle('reminders:delete', (_, id) => db.deleteReminder(id));
  ipcMain.handle('settings:get', () => db.getSettings());
  ipcMain.handle('settings:save', (_, settings) => { const saved=db.saveSettings(settings); if(Object.prototype.hasOwnProperty.call(settings,'startupEnabled'))app.setLoginItemSettings({openAtLogin:Boolean(settings.startupEnabled),openAsHidden:true}); return saved; });
  ipcMain.handle('data:export', () => db.exportData());
  ipcMain.handle('data:import', (_, json) => db.importData(json));
  ipcMain.handle('app:notification-status', () => Notification.isSupported());
  ipcMain.handle('app:minimize-tray', () => { win.hide(); return true; });
  ipcMain.handle('update:state', () => updates.snapshot());
  ipcMain.handle('update:check', () => updates.check());
  ipcMain.handle('update:download', () => updates.download());
  ipcMain.handle('update:install', () => updates.install());
}

app.whenReady().then(async () => {
  if (!hasLock) return;
  db = await Database.create(app.getPath('userData'));
  updates = createUpdates({
    updater: autoUpdater,
    version: app.getVersion(),
    enabled: app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE,
    beforeInstall: () => { db.backupForUpdate(app.getVersion()); },
    onState: status => { if (win && !win.isDestroyed()) win.webContents.send('update:status', status); }
  });
  autoUpdater.on('before-quit-for-update', () => { app.isQuitting = true; });
  app.setLoginItemSettings({openAtLogin:db.getSetting('startupEnabled',false),openAsHidden:true});
  registerIpc();
  createWindow();
  createTray();
  reminderTimer = setInterval(checkReminders, 30 * 1000);
  checkReminders();
  app.on('activate', () => { if (win) win.show(); });
});

app.on('window-all-closed', event => event.preventDefault());
app.on('before-quit', () => { app.isQuitting = true; clearTimeout(updateTimer); clearInterval(reminderTimer); if (db) db.close(); });
