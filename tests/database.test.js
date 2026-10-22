const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('../src/db/database');

async function withDatabase(run) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-reminder-test-'));
  let db;
  try {
    db = await Database.create(folder);
    await run(db, folder);
  } finally {
    db?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

const todo = (overrides = {}) => ({
  title: '测试事项', body: '', date: '2026-10-21', priority: 'normal', category: '',
  repeat: { frequency: 'none' }, ...overrides,
});

test('pre-update SQLite backup preserves saved todos and settings without replacing user data', async () => withDatabase(async (db, folder) => {
  const item = db.saveTodo(todo({ title: '升级前的数据' }));
  db.saveSettings({ theme: 'dark', fontSize: 18 });
  const backup = db.backupForUpdate('0.1.0');
  assert.equal(path.dirname(backup), path.join(folder, 'backups'));
  assert.deepEqual(fs.readFileSync(backup), fs.readFileSync(db.file));
  db.deleteTodo(item.id);
  assert.notDeepEqual(fs.readFileSync(backup), fs.readFileSync(db.file));
  const restoredFolder = path.join(folder, 'restored');
  fs.mkdirSync(restoredFolder);
  fs.copyFileSync(backup, path.join(restoredFolder, 'daily-reminder.sqlite'));
  const restored = await Database.create(restoredFolder);
  try {
    assert.equal(restored.getDayData('2026-10-21').todos[0].title, '升级前的数据');
    assert.equal(restored.getSettings().theme, 'dark');
    assert.equal(restored.getSettings().fontSize, 18);
  } finally { restored.close(); }
}));

test('weekly recurrence defaults to the start weekday and supports selected weekdays', async () => withDatabase(async db => {
  const defaultSeries = db.saveTodo(todo({ repeat: { frequency: 'weekly', endDate: '2026-11-04' } }));
  assert.deepEqual(db.all('SELECT date FROM todos WHERE series_id=? ORDER BY date', [defaultSeries.series_id]).map(row => row.date), [
    '2026-10-21', '2026-10-28', '2026-11-04',
  ]);

  const customSeries = db.saveTodo(todo({ title: '周一和周三', repeat: { frequency: 'custom', weekdays: [1, 3], endDate: '2026-10-28' } }));
  assert.deepEqual(db.all('SELECT date FROM todos WHERE series_id=? ORDER BY date', [customSeries.series_id]).map(row => row.date), [
    '2026-10-21', '2026-10-26', '2026-10-28',
  ]);
}));

test('repeating todos receive a reminder for each generated occurrence', async () => withDatabase(async db => {
  const firstReminder = new Date(2026, 9, 21, 9, 0).toISOString();
  const created = db.saveTodo(todo({ repeat: { frequency: 'weekly', endDate: '2026-11-04' }, reminders: [{ remindAt: firstReminder }] }));
  const reminderRows = db.all('SELECT r.remind_at FROM reminders r JOIN todos t ON t.id=r.todo_id WHERE t.series_id=? ORDER BY t.date', [created.series_id]);
  assert.equal(reminderRows.length, 3);
  assert.deepEqual(reminderRows.map(row => new Date(row.remind_at).getHours()), [9, 9, 9]);
}));

test('new todo returns its own id and can be moved to another date', async () => withDatabase(async db => {
  const existing = db.saveTodo(todo({ title: '重名' }));
  const created = db.saveTodo(todo({ title: '重名' }));
  assert.notEqual(created.id, existing.id);
  const moved = db.saveTodo({ ...created, date: '2026-10-25', startTime: '', dueTime: '' });
  assert.equal(moved.date, '2026-10-25');
  assert.equal(db.getDayData('2026-10-21').todos.length, 1);
  assert.equal(db.getDayData('2026-10-25').todos[0].id, created.id);
}));

test('drag move updates the single occurrence date and shifts its reminders', async () => withDatabase(async db => {
  const created = db.saveTodo(todo({ dueTime: '12:00', reminders: [{ remindAt: '2026-10-21T09:00:00.000Z' }] }));
  const before = db.get('SELECT remind_at FROM reminders WHERE todo_id=?', [created.id]).remind_at;
  const moved = db.moveTodo(created.id, '2026-10-23');
  const after = db.get('SELECT remind_at FROM reminders WHERE todo_id=?', [created.id]).remind_at;
  assert.equal(moved.date, '2026-10-23');
  assert.equal(moved.occurrence_date, '2026-10-23');
  assert.equal(Date.parse(after)-Date.parse(before), 2*24*60*60*1000);
  assert.equal(db.getOverdueTodos('2026-10-24','00:00').length, 1);
}));

test('moving one repeating occurrence does not move its siblings', async () => withDatabase(async db => {
  const first = db.saveTodo(todo({ repeat: { frequency: 'weekly', endDate: '2026-11-04' } }));
  const occurrences = db.all('SELECT id FROM todos WHERE series_id=? ORDER BY date', [first.series_id]);
  db.moveTodo(occurrences[1].id, '2026-10-30');
  assert.equal(db.get('SELECT date FROM todos WHERE id=?', [occurrences[1].id]).date, '2026-10-30');
  assert.equal(db.get('SELECT date FROM todos WHERE id=?', [occurrences[0].id]).date, '2026-10-21');
  assert.equal(db.get('SELECT date FROM todos WHERE id=?', [occurrences[2].id]).date, '2026-11-04');
}));

test('overdue query includes earlier incomplete dates and past deadlines today only', async () => withDatabase(async db => {
  db.saveTodo(todo({ date: '2026-10-20' }));
  db.saveTodo(todo({ title: '今天早些时候', dueTime: '08:00' }));
  db.saveTodo(todo({ title: '今天晚些时候', dueTime: '18:00' }));
  assert.deepEqual(db.getOverdueTodos('2026-10-21','12:00').map(item=>item.title), ['测试事项','今天早些时候']);
}));

test('completion toggles do not create duplicate history records', async () => withDatabase(async db => {
  const created = db.saveTodo(todo());
  db.setTodoCompleted(created.id, true);
  db.setTodoCompleted(created.id, true);
  const record = db.get('SELECT completed_date FROM completion_records WHERE todo_id=?', [created.id]);
  assert.ok(record.completed_date);
  assert.equal(db.getDayData(record.completed_date).completions.length, 1);
  db.setTodoCompleted(created.id, false);
  assert.equal(db.getDayData(record.completed_date).completions.length, 0);
}));

test('history search finds completed and pending items; failed import leaves data untouched', async () => withDatabase(async db => {
  const created = db.saveTodo(todo({ title: '每周采购清单' }));
  assert.equal(db.searchHistory('采购').length, 1);
  db.setTodoCompleted(created.id, true);
  assert.equal(db.searchHistory('每周')[0].completed, 1);
  assert.throws(() => db.importData({ version: 1, data: { todos: [{ id: 'bad', title: '丢弃', date: '2026-10-21', "date); DROP TABLE todos; --": 1 }] } }));
  assert.equal(db.get('SELECT title FROM todos WHERE id=?', [created.id]).title, '每周采购清单');
}));

test('daily reminder lookup uses local day boundaries for UTC timestamps', async () => withDatabase(async db => {
  const reminderAt = new Date(2026, 9, 21, 0, 30).toISOString();
  const localDay = `${new Date(reminderAt).getFullYear()}-${String(new Date(reminderAt).getMonth()+1).padStart(2,'0')}-${String(new Date(reminderAt).getDate()).padStart(2,'0')}`;
  db.saveReminder({ title: '本地凌晨提醒', remindAt: reminderAt });
  assert.equal(db.getDayData(localDay).reminders.length, 1);
}));

test('reminder fires once and snoozing schedules one later notification', async () => withDatabase(async db => {
  const reminder = db.saveReminder({ title: '提醒', remindAt: new Date(Date.now() - 60_000).toISOString() });
  const dueAt = new Date();
  assert.equal(db.getDueReminders(dueAt).length, 1);
  db.markReminderTriggered(reminder.id);
  assert.equal(db.getDueReminders(dueAt).length, 0);

  const snoozedUntil = db.snoozeReminder(reminder.id, 15);
  assert.equal(db.getDueReminders(dueAt).length, 0);
  assert.equal(db.getDueReminders(new Date(Date.parse(snoozedUntil) + 1)).length, 1);
}));

test('series edit scopes update requested occurrences and persist across reopen', async () => withDatabase(async (db, folder) => {
  const first = db.saveTodo(todo({ repeat: { frequency: 'weekly', endDate: '2026-11-04' } }));
  const ids = db.all('SELECT id FROM todos WHERE series_id=? ORDER BY date', [first.series_id]).map(row => row.id);
  db.saveTodo({ ...first, title: '只改本次' }, 'single');
  assert.equal(db.get('SELECT title FROM todos WHERE id=?', [ids[0]]).title, '只改本次');
  assert.equal(db.get('SELECT title FROM todos WHERE id=?', [ids[1]]).title, '测试事项');
  db.saveTodo({ ...first, title: '修改本次及以后' }, 'future');
  assert.equal(db.get('SELECT title FROM todos WHERE id=?', [ids[1]]).title, '修改本次及以后');

  db.close();
  db = await Database.create(folder);
  assert.equal(db.get('SELECT title FROM todos WHERE id=?', [ids[1]]).title, '修改本次及以后');
  db.deleteTodo(first.id, 'series');
  assert.equal(db.all('SELECT id FROM todos WHERE series_id=?', [first.series_id]).length, 0);
}));
