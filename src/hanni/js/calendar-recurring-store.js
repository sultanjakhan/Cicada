export const RECURRING_KEY = 'calendar_recurring_v1';
const clone = value => JSON.parse(JSON.stringify(value));
const queues = new WeakMap();
export const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && dateKey(new Date(value+'T12:00:00')) === value; }
const empty = () => ({version:1, plans:[], days:{}});
const allowed = kind => kind === 'rule' ? ['pending','kept','broken'] : ['pending','done','skipped'];
function planFields(fields, old, today, id) {
  const plan = {id, kind:fields.kind, title:String(fields.title||'').trim(), weekdays:[...new Set(fields.weekdays||[])],
    startsOn:String(fields.startsOn||''), endsOn:String(fields.endsOn||''), time:String(fields.time||''),
    active:fields.active!==false, required:fields.required!==false, createdOn:old?.createdOn||today};
  if (!plan.title || plan.title.length > 160) throw Error('Название: от 1 до 160 символов.');
  if (!['action','rule'].includes(plan.kind) || (old && old.kind!==plan.kind)) throw Error('Для другого способа учёта создай отдельную запись.');
  if (!plan.weekdays.length || plan.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)) throw Error('Выбери хотя бы один день недели.');
  for (const date of [plan.startsOn,plan.endsOn,plan.createdOn]) if (date && !validDate(date)) throw Error('Проверь дату.');
  if (plan.endsOn && plan.endsOn < (plan.startsOn || plan.createdOn)) throw Error('Конец курса должен быть не раньше начала.');
  if (plan.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.time)) throw Error('Проверь время.');
  return plan;
}
export function parseRecurring(raw) {
  if (!raw) return empty();
  let state;
  try {
    state=JSON.parse(raw);
    if (state.version!==1 || !Array.isArray(state.plans) || state.plans.length>1000 || !state.days || Array.isArray(state.days) || typeof state.days!=='object') throw Error();
    const ids=new Set();
    for (const plan of state.plans) {
      if (typeof plan.id!=='string'||!plan.id||ids.has(plan.id)) throw Error();
      planFields(plan,plan,plan.createdOn,plan.id); ids.add(plan.id);
    }
    for (const [day,records] of Object.entries(state.days)) {
      if (!validDate(day) || !records || typeof records!=='object' || Array.isArray(records)) throw Error();
      for (const [id,record] of Object.entries(records)) {
        if (record.snapshot.id!==id || !allowed(record.snapshot.kind).includes(record.status)) throw Error();
        planFields(record.snapshot,record.snapshot,day,id);
      }
    }
  } catch { throw Error('Не удалось прочитать дела и правила. Сохранённые данные не изменены.'); }
  return state;
}
export function applies(plan,date) {
  return plan.active && date >= (plan.startsOn || plan.createdOn) && (!plan.endsOn || date<=plan.endsOn) && plan.weekdays.includes(new Date(date+'T12:00:00').getDay());
}
export function recurringItems(state,date) {
  if (!validDate(date)) throw Error('Выбери корректную дату.');
  const records=state.days[date]||{};
  const plans=new Map(state.plans.filter(plan=>applies(plan,date)).map(plan=>[plan.id,{...plan,status:'pending'}]));
  for (const [id,record] of Object.entries(records)) plans.set(id,{...record.snapshot,status:record.status});
  return [...plans.values()].sort((a,b)=>(a.time||'99').localeCompare(b.time||'99')||a.title.localeCompare(b.title,'ru'));
}
export function createRecurringStore(invoke,{now=()=>new Date(),uuid=()=>crypto.randomUUID()}={}) {
  const read = async () => parseRecurring(await invoke('get_ui_state',{key:RECURRING_KEY}));
  function update(change) {
    const job=(queues.get(invoke)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const raw=await invoke('get_ui_state',{key:RECURRING_KEY});
      const state=parseRecurring(raw); const result=change(state);
      try { await invoke('set_ui_state',{key:RECURRING_KEY,value:JSON.stringify(state),expectedValue:raw??''}); }
      catch(error) { if((error?.message||error)==='mvp_sync_stale_ui_state')throw Error('Расписание изменено на другом устройстве. Обнови его и повтори действие.');throw error; }
      return {state,result};
    });
    queues.set(invoke,job); return job;
  }
  return { read, today:()=>dateKey(now()),
    savePlan(fields,id=null,{expectedPlan=null}={}) { return update(state=>{
      const old=id?state.plans.find(plan=>plan.id===id):null;
      if (id&&!old) throw Error('Запись больше недоступна.');
      if (old && expectedPlan && JSON.stringify(planFields(old,old,old.createdOn,id)) !== JSON.stringify(planFields(expectedPlan,expectedPlan,expectedPlan.createdOn,id))) throw Error('Это расписание изменено на другом устройстве. Черновик остаётся в открытой форме. Открой расписание заново перед сохранением.');
      if (!old&&state.plans.length>=1000) throw Error('Достигнут предел записей. Сначала заверши неактуальные расписания.');
      const plan=planFields(fields,old,dateKey(now()),id||uuid());
      if (old) state.plans[state.plans.indexOf(old)]=plan; else state.plans.push(plan);
      const record=state.days[dateKey(now())]?.[plan.id];
      if (record) record.snapshot=clone(plan);
      return plan.id;
    }); },
    setStatus(id,status,date=dateKey(now())) { return update(state=>{
      if (!validDate(date)||date>dateKey(now())) throw Error('Отметить можно только наступивший день.');
      const record=state.days[date]?.[id];
      const plan=record?.snapshot||state.plans.find(item=>item.id===id);
      if (!plan || (!record&&!applies(plan,date))) throw Error('На этот день повторение не запланировано.');
      if (!allowed(plan.kind).includes(status)) throw Error('Недопустимая отметка.');
      state.days[date]||={};
      state.days[date][id]={snapshot:clone(plan),status};
    }); },
  };
}
