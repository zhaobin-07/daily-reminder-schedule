const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDay: date => ipcRenderer.invoke('todos:day', date),
  getRange: (from, to) => ipcRenderer.invoke('todos:range', from, to),
  getOverdue: (today, time) => ipcRenderer.invoke('todos:overdue', today, time),
  moveTodo: (id, date) => ipcRenderer.invoke('todos:move', id, date),
  searchHistory: query => ipcRenderer.invoke('history:search', query),
  saveTodo: (todo, scope) => ipcRenderer.invoke('todos:save', todo, scope),
  deleteTodo: (id, scope) => ipcRenderer.invoke('todos:delete', id, scope),
  completeTodo: (id, completed) => ipcRenderer.invoke('todos:complete', id, completed),
  saveReminder: reminder => ipcRenderer.invoke('reminders:save', reminder),
  listReminders: () => ipcRenderer.invoke('reminders:list'),
  completeReminder: (id, completed) => ipcRenderer.invoke('reminders:complete', id, completed),
  snoozeReminder: (id, minutes) => ipcRenderer.invoke('reminders:snooze', id, minutes),
  deleteReminder: id => ipcRenderer.invoke('reminders:delete', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: json => ipcRenderer.invoke('data:import', json),
  notificationSupported: () => ipcRenderer.invoke('app:notification-status'),
  minimizeToTray: () => ipcRenderer.invoke('app:minimize-tray'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: callback => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  }
});
