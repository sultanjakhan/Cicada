// Presentation-only tabs: hiding a view never starts, pauses or completes work.
export function mountDashboardWorkViews(host) {
 const tabs=[...host.querySelectorAll('[data-work-view]')],panels=[...host.querySelectorAll('[data-work-panel]')];
 function select(id,{focus=false}={}){
  const chosen=tabs.find(tab=>tab.dataset.workView===id);if(!chosen)return;
  for(const tab of tabs){const active=tab===chosen;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
  for(const panel of panels)panel.hidden=panel.dataset.workPanel!==id;
  if(focus)chosen.focus({preventScroll:true});
 }
 const click=event=>{const tab=event.target.closest('[data-work-view]');if(tab&&tabs.includes(tab))select(tab.dataset.workView);};
 const key=event=>{const index=tabs.indexOf(event.target);if(index<0)return;let next;
  if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;
  event.preventDefault();select(tabs[next].dataset.workView,{focus:true});
 };
 host.addEventListener('click',click);host.addEventListener('keydown',key);select('personal');
 const dispose=()=>{host.removeEventListener('click',click);host.removeEventListener('keydown',key);};dispose.select=select;return dispose;
}
