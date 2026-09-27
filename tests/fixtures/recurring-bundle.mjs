// Synthetic bundle adapter for existing UI fixtures. Native CAS, migration and
// journal semantics are tested through Rust IPC; this fixture models the shape.
const adapters=new WeakMap();
const clone=value=>JSON.parse(JSON.stringify(value));
export function withRecurringBundle(invoke) {
  if(adapters.has(invoke))return adapters.get(invoke);
  let sidecar={version:1,plans:{},days:{}};
  function migrate(state) {
    for(const plan of state?.plans||[])if(plan.reflection&&!sidecar.plans[plan.id])sidecar.plans[plan.id]={legacy:true,enabled:true,prompt:plan.reflection.prompt};
    for(const [date,rows] of Object.entries(state?.days||{}))for(const [id,row] of Object.entries(rows))if(row.snapshot.reflection&&!sidecar.days[date]?.[id]){
      const snapshot=clone(row.snapshot);delete snapshot.reflection;
      sidecar.days[date]||={};sidecar.days[date][id]={legacy:true,prompt:row.snapshot.reflection.prompt,snapshot,status:row.status,answer:row.reflection||null};
    }
  }
  const wrapped=async(name,args)=>{
    if(!['recurring_get_bundle','recurring_save_bundle'].includes(name))return invoke(name,args);
    const raw=await invoke('get_ui_state',{key:'calendar_recurring_v1'});
    const state=raw?JSON.parse(raw):{version:1,plans:[],days:{}};
    migrate(state);
    if(name==='recurring_get_bundle')return {recurring:raw,reflections:JSON.stringify(sidecar)};
    const next=JSON.parse(args.value),protectedNext=clone(sidecar),change=args.reflectionChange;
    if(change?.kind==='plan')protectedNext.plans[change.id]={legacy:false,enabled:change.prompt!==null,prompt:change.prompt};
    if(change?.kind==='answer'){
      const row=next.days[change.date][change.id],old=protectedNext.days[change.date]?.[change.id],snapshot=clone(old?.snapshot||row.snapshot);delete snapshot.reflection;
      protectedNext.days[change.date]||={};protectedNext.days[change.date][change.id]={legacy:false,prompt:old?.prompt||row.snapshot.reflection.prompt,snapshot,status:row.status,answer:clone(change.answer)};
    }
    for(const plan of next.plans)delete plan.reflection;
    for(const [date,rows] of Object.entries(next.days))for(const [id,row] of Object.entries(rows)){
      if(row._reflectionOnly){delete rows[id];continue;}
      if(row.snapshot.reflection&&!protectedNext.days[date]?.[id]){
        const snapshot=clone(row.snapshot);delete snapshot.reflection;
        protectedNext.days[date]||={};protectedNext.days[date][id]={legacy:false,prompt:row.snapshot.reflection.prompt,snapshot,status:row.status,answer:null};
      }
      delete row.reflection;delete row.snapshot.reflection;
    }
    await invoke('set_ui_state',{key:'calendar_recurring_v1',value:JSON.stringify(next),expectedValue:args.expectedRecurring});
    sidecar=protectedNext;
    return {recurring:JSON.stringify(next),reflections:JSON.stringify(sidecar)};
  };
  adapters.set(invoke,wrapped);return wrapped;
}
