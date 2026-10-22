const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const localDate = value => `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;

class Database {
  static async create(userDataPath) { const instance = new Database(userDataPath); await instance.init(); return instance; }
  constructor(userDataPath) { fs.mkdirSync(userDataPath, { recursive: true }); this.file = path.join(userDataPath, 'daily-reminder.sqlite'); }
  async init() {
    const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
    const bytes = fs.existsSync(this.file) ? fs.readFileSync(this.file) : undefined;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run(`CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT DEFAULT '',date TEXT NOT NULL,start_time TEXT,due_time TEXT,priority TEXT NOT NULL DEFAULT 'normal',category TEXT DEFAULT '',completed INTEGER NOT NULL DEFAULT 0,completed_at TEXT,series_id TEXT,occurrence_date TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,todo_id TEXT,title TEXT NOT NULL,body TEXT DEFAULT '',remind_at TEXT NOT NULL,important INTEGER NOT NULL DEFAULT 0,snoozed_until TEXT,completed INTEGER NOT NULL DEFAULT 0,triggered INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recurrence_rules(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,frequency TEXT NOT NULL,weekdays TEXT DEFAULT '',end_date TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_records(id TEXT PRIMARY KEY,todo_id TEXT NOT NULL,todo_title TEXT NOT NULL,completed_date TEXT NOT NULL,completed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const defaults={theme:'system',accent:'#5b6cff',fontFamily:'Microsoft YaHei',fontSize:15,titleSize:28,bodySize:15,dateSize:13,buttonSize:14,fontWeight:400,density:'standard',layout:'two',rightPanel:true,radius:18,gap:16,sidebarWidth:230,notificationsEnabled:true,defaultAdvance:15,startupEnabled:false};
    Object.entries(defaults).forEach(([key,value])=>this.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)',[key,JSON.stringify(value)])); this.persist();
  }
  run(sql,params=[]){const stmt=this.db.prepare(sql);stmt.bind(params);stmt.step();stmt.free();}
  all(sql,params=[]){const stmt=this.db.prepare(sql);stmt.bind(params);const rows=[];while(stmt.step())rows.push(stmt.getAsObject());stmt.free();return rows;}
  get(sql,params=[]){return this.all(sql,params)[0]||null;}
  persist(){fs.writeFileSync(this.file,Buffer.from(this.db.export()));}
  backupForUpdate(version){this.persist();const folder=path.join(path.dirname(this.file),'backups');fs.mkdirSync(folder,{recursive:true});const safeVersion=String(version).replace(/[^a-zA-Z0-9.-]/g,'_');const target=path.join(folder,`before-update-${safeVersion}-${Date.now()}-${newId()}.sqlite`);fs.copyFileSync(this.file,target,fs.constants.COPYFILE_EXCL);return target;}
  getSetting(key,fallback){const row=this.get('SELECT value FROM settings WHERE key=?',[key]);return row?JSON.parse(row.value):fallback;}
  getSettings(){return Object.fromEntries(this.all('SELECT key,value FROM settings').map(row=>[row.key,JSON.parse(row.value)]));}
  saveSettings(settings){Object.entries(settings).forEach(([key,value])=>this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,JSON.stringify(value)]));this.persist();return this.getSettings();}
  getDayData(date){const start=new Date(`${date}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);return{todos:this.all('SELECT * FROM todos WHERE date=? ORDER BY completed ASC,COALESCE(start_time,due_time,"23:59") ASC,created_at ASC',[date]),reminders:this.all('SELECT * FROM reminders WHERE remind_at>=? AND remind_at<? ORDER BY remind_at',[start.toISOString(),end.toISOString()]),completions:this.all('SELECT * FROM completion_records WHERE completed_date=? ORDER BY completed_at DESC',[date])};}
  searchHistory(query=''){const term=`%${String(query).trim()}%`;return this.all('SELECT t.*,c.completed_date AS recorded_date,c.completed_at AS recorded_at FROM todos t LEFT JOIN completion_records c ON c.todo_id=t.id WHERE t.title LIKE ? OR t.body LIKE ? ORDER BY COALESCE(c.completed_at,t.date) DESC,t.created_at DESC LIMIT 500',[term,term]);}
  getTodosInRange(from,to){return this.all('SELECT date,COUNT(*) count,SUM(completed) completed FROM todos WHERE date BETWEEN ? AND ? GROUP BY date',[from,to]);}
  getOverdueTodos(today,time){return this.all('SELECT * FROM todos WHERE completed=0 AND (date<? OR (date=? AND due_time IS NOT NULL AND due_time<?)) ORDER BY date,due_time',[today,today,time]);}
  moveTodo(todoId,date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('日期格式无效');const todo=this.get('SELECT * FROM todos WHERE id=?',[todoId]);if(!todo)throw new Error('待办不存在');const from=new Date(`${todo.date}T12:00:00`),to=new Date(`${date}T12:00:00`),offset=Math.round((to-from)/86400000);this.run('UPDATE todos SET date=?,occurrence_date=?,updated_at=? WHERE id=?',[date,date,nowIso(),todoId]);if(offset){this.all('SELECT id,remind_at,triggered FROM reminders WHERE todo_id=?',[todoId]).forEach(reminder=>{if(reminder.triggered)return;const at=new Date(reminder.remind_at);at.setDate(at.getDate()+offset);this.run('UPDATE reminders SET remind_at=?,snoozed_until=NULL WHERE id=?',[at.toISOString(),reminder.id]);});}this.persist();return this.get('SELECT * FROM todos WHERE id=?',[todoId]);}
  saveTodo(input,scope='single'){
    const timestamp=nowIso();
    if(input.id){
      const current=this.get('SELECT * FROM todos WHERE id=?',[input.id]);if(!current)throw new Error('待办不存在');
      const targets=scope==='series'&&current.series_id?this.all('SELECT id FROM todos WHERE series_id=?',[current.series_id]):scope==='future'&&current.series_id?this.all('SELECT id FROM todos WHERE series_id=? AND date>=?',[current.series_id,current.date]):[{id:input.id}];
      targets.forEach(target=>{const selected=target.id===input.id;this.run('UPDATE todos SET title=?,body=?,date=?,start_time=?,due_time=?,priority=?,category=?,updated_at=? WHERE id=?',[input.title,input.body||'',selected?input.date:this.get('SELECT date FROM todos WHERE id=?',[target.id]).date,input.startTime||null,input.dueTime||null,input.priority||'normal',input.category||'',timestamp,target.id]);});
      if(input.reminders)this.replaceTodoReminders(input.id,input.reminders);
      this.persist();return this.get('SELECT * FROM todos WHERE id=?',[input.id]);
    }
    const seriesId=input.repeat&&input.repeat.frequency!=='none'?newId():null;
    const dates=this.expandDates(input.date,input.repeat,seriesId?366:1);
    let firstId;
    dates.forEach((date,index)=>{const id=newId();if(index===0)firstId=id;this.run('INSERT INTO todos(id,title,body,date,start_time,due_time,priority,category,series_id,occurrence_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,input.title,input.body||'',date,input.startTime||null,input.dueTime||null,input.priority||'normal',input.category||'',seriesId,date,timestamp,timestamp]);});
    if(seriesId)this.run('INSERT INTO recurrence_rules(id,series_id,frequency,weekdays,end_date,created_at) VALUES(?,?,?,?,?,?)',[newId(),seriesId,input.repeat.frequency,(input.repeat.weekdays||[]).join(','),input.repeat.endDate||null,timestamp]);
    const first=this.get('SELECT * FROM todos WHERE id=?',[firstId]);
    if(input.reminders&&first){const firstDate=new Date(`${input.date}T12:00:00`);dates.forEach((date,index)=>{const occurrence=new Date(`${date}T12:00:00`),offset=Math.round((occurrence-firstDate)/86400000);const reminders=input.reminders.map(item=>{const remindAt=new Date(item.remindAt);remindAt.setDate(remindAt.getDate()+offset);return{...item,remindAt:remindAt.toISOString()}});this.replaceTodoReminders(index===0?first.id:this.get('SELECT id FROM todos WHERE series_id=? AND date=?',[seriesId,date]).id,reminders);});}
    this.persist();return first;
  }
  expandDates(start,repeat={frequency:'none'},max=1){if(!repeat||repeat.frequency==='none')return[start];const end=repeat.endDate?new Date(`${repeat.endDate}T23:59:59`):new Date(`${start}T23:59:59`);if(!repeat.endDate)end.setDate(end.getDate()+90);const startDate=new Date(`${start}T12:00:00`),cursor=new Date(startDate),result=[];while(cursor<=end&&result.length<max){const day=cursor.getDay(),weekdays=repeat.weekdays?.length?repeat.weekdays:[startDate.getDay()];const ok=repeat.frequency==='daily'||(repeat.frequency==='weekly'&&weekdays.includes(day))||(repeat.frequency==='monthly'&&cursor.getDate()===startDate.getDate())||(repeat.frequency==='custom'&&weekdays.includes(day));if(ok)result.push(cursor.toISOString().slice(0,10));cursor.setDate(cursor.getDate()+1);}return result.length?result:[start];}
  replaceTodoReminders(todoId,reminders){this.run('DELETE FROM reminders WHERE todo_id=?',[todoId]);reminders.filter(item=>item.remindAt).forEach(item=>this.run('INSERT INTO reminders(id,todo_id,title,body,remind_at,important,created_at) VALUES(?,?,?,?,?,?,?)',[newId(),todoId,item.title||'待办提醒',item.body||'',item.remindAt,item.important?1:0,nowIso()]));}
  setTodoCompleted(todoId,completed){const todo=this.get('SELECT * FROM todos WHERE id=?',[todoId]);if(!todo)return null;const next=completed?1:0;if(todo.completed===next)return todo;const at=completed?nowIso():null;this.run('UPDATE todos SET completed=?,completed_at=?,updated_at=? WHERE id=?',[next,at,nowIso(),todoId]);if(completed)this.run('INSERT INTO completion_records(id,todo_id,todo_title,completed_date,completed_at) VALUES(?,?,?,?,?)',[newId(),todoId,todo.title,localDate(new Date(at)),at]);else this.run('DELETE FROM completion_records WHERE todo_id=?',[todoId]);this.persist();return this.get('SELECT * FROM todos WHERE id=?',[todoId]);}
  deleteTodo(todoId,scope='single'){const todo=this.get('SELECT * FROM todos WHERE id=?',[todoId]);if(!todo)return false;const targets=scope==='series'&&todo.series_id?this.all('SELECT id FROM todos WHERE series_id=?',[todo.series_id]):scope==='future'&&todo.series_id?this.all('SELECT id FROM todos WHERE series_id=? AND date>=?',[todo.series_id,todo.date]):[{id:todoId}];targets.forEach(target=>{this.run('DELETE FROM reminders WHERE todo_id=?',[target.id]);this.run('DELETE FROM todos WHERE id=?',[target.id]);});if(todo.series_id&&!this.get('SELECT id FROM todos WHERE series_id=? LIMIT 1',[todo.series_id]))this.run('DELETE FROM recurrence_rules WHERE series_id=?',[todo.series_id]);this.persist();return true;}
  saveReminder(input){const timestamp=nowIso();if(input.id)this.run('UPDATE reminders SET title=?,body=?,remind_at=?,important=? WHERE id=?',[input.title,input.body||'',input.remindAt,input.important?1:0,input.id]);else this.run('INSERT INTO reminders(id,todo_id,title,body,remind_at,important,created_at) VALUES(?,?,?,?,?,?,?)',[newId(),input.todoId||null,input.title,input.body||'',input.remindAt,input.important?1:0,timestamp]);this.persist();return input.id?this.get('SELECT * FROM reminders WHERE id=?',[input.id]):this.get('SELECT * FROM reminders ORDER BY created_at DESC LIMIT 1');}
  listReminders(){return this.all('SELECT * FROM reminders WHERE completed=0 ORDER BY remind_at');}
  setReminderCompleted(id,completed){this.run('UPDATE reminders SET completed=? WHERE id=?',[completed?1:0,id]);this.persist();return true;}
  deleteReminder(id){this.run('DELETE FROM reminders WHERE id=?',[id]);this.persist();return true;}
  snoozeReminder(reminderId,minutes=15){const until=new Date(Date.now()+minutes*60000).toISOString();this.run('UPDATE reminders SET snoozed_until=?,triggered=0 WHERE id=?',[until,reminderId]);this.persist();return until;}
  getDueReminders(now){return this.all('SELECT * FROM reminders WHERE completed=0 AND triggered=0 AND COALESCE(snoozed_until,remind_at)<=?',[now.toISOString()]);}
  markReminderTriggered(id){this.run('UPDATE reminders SET triggered=1 WHERE id=?',[id]);this.persist();}
  exportData(){const data={};['todos','reminders','recurrence_rules','completion_records','settings'].forEach(table=>{data[table]=this.all(`SELECT * FROM ${table}`);});return JSON.stringify({version:1,exportedAt:nowIso(),data},null,2);}
  importData(json){const parsed=typeof json==='string'?JSON.parse(json):json;if(!parsed?.data||parsed.version!==1)throw new Error('无效或不支持的备份文件');const columns={todos:['id','title','body','date','start_time','due_time','priority','category','completed','completed_at','series_id','occurrence_date','created_at','updated_at'],reminders:['id','todo_id','title','body','remind_at','important','snoozed_until','completed','triggered','created_at'],recurrence_rules:['id','series_id','frequency','weekdays','end_date','created_at'],completion_records:['id','todo_id','todo_title','completed_date','completed_at'],settings:['key','value']};for(const [table,rows] of Object.entries(parsed.data)){if(!columns[table]||!Array.isArray(rows))throw new Error('备份包含不支持的数据表');rows.forEach(row=>{if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!columns[table].includes(key)))throw new Error(`备份数据格式错误：${table}`);});}this.db.run('BEGIN');try{Object.entries(columns).forEach(([table,allowed])=>{this.run(`DELETE FROM ${table}`);(parsed.data[table]||[]).forEach(row=>{const keys=Object.keys(row);if(!keys.length)throw new Error(`备份数据为空：${table}`);this.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,keys.map(key=>row[key]));});});this.db.run('COMMIT');this.persist();return true;}catch(error){this.db.run('ROLLBACK');throw error;}}
  close(){if(this.db){this.persist();this.db.close();this.db=null;}}
}
module.exports=Database;
