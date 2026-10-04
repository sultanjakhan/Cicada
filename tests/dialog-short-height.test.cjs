const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const modulePath=process.env.CICADA_PLAYWRIGHT_MODULE;
test('Task and Goal keep long Unicode titles scrollable, body usable and focused actions visible in short light/dark dialogs',{skip:!modulePath},async()=>{
 const {chromium}=require(modulePath);const {createCalendarDialog}=await import('../src/hanni/js/calendar-dialog.js');
 const browser=await chromium.launch({channel:'msedge',headless:true});const measurements=[];
 const css=['base.css','mvp-palette.css','calendar-editor-shell.css','calendar-task-details.css','calendar-development.css'].map(n=>fs.readFileSync(path.join(__dirname,'../src/hanni/css',n),'utf8')).join('\n');
 try{for(const [width,height] of [[390,320],[640,400]])for(const theme of ['light','dark'])for(const type of ['task','goal'])for(const length of [70,500]){
  const title='Синтетический длинный заголовок Жұмыс 🚀 '+ '界'.repeat(length),dom=new JSDOM('<body></body>');const dialog=createCalendarDialog({document:dom.window.document,title,submitLabel:type==='task'?'Готово':null});dialog.modal.classList.add(type==='task'?'calendar-task-details':'calendar-goal-popup');
  dialog.modal.querySelector('.calendar-editor-header > div').tabIndex=0;
  dialog.body.innerHTML='<section class="task-details-card"><p>'+('Полное полезное содержание Жұмыс 🚀 '.repeat(35))+'</p><details class="task-workflow"><summary>Шаги и результат</summary><label>Результат<textarea></textarea></label></details><button type="button">Действие с записью</button></section>';
  dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
  const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<html data-theme="'+theme+'"><body>'+dialog.modal.outerHTML+'</body></html>');await page.addStyleTag({content:css});await page.evaluate(()=>document.querySelector('dialog').showModal());
  const data=await page.evaluate(()=>{const d=document.querySelector('dialog'),body=d.querySelector('.calendar-editor-body'),heading=d.querySelector('.calendar-editor-header > div'),footer=d.querySelector('footer'),close=footer.querySelector('[data-dialog-close]');close.focus();const r=close.getBoundingClientRect(),f=footer.getBoundingClientRect();heading.scrollTop=heading.scrollHeight;body.scrollTop=body.scrollHeight;return {title:d.querySelector('h2').textContent,bodyHeight:body.clientHeight,bodyScroll:body.scrollTop,headingHeight:heading.clientHeight,headingScrollable:heading.scrollHeight>heading.clientHeight,headingScroll:heading.scrollTop,closeFocused:document.activeElement===close,focusedActionVisible:r.top>=0&&r.bottom<=innerHeight,footerVisible:f.top>=0&&f.bottom<=innerHeight,width:d.getBoundingClientRect().width,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth};});
  measurements.push({width,height,theme,type,length,...data});
  try{assert.equal(data.title,title);assert.ok(data.bodyHeight>=100,JSON.stringify({width,height,theme,type,length,...data}));assert.ok(data.bodyScroll>0);assert.ok(data.headingScrollable);assert.ok(data.headingScroll>0);assert.ok(data.closeFocused&&data.focusedActionVisible&&data.footerVisible);assert.ok(data.scrollWidth<=data.clientWidth+1);await page.locator('.task-workflow summary').click();assert.equal(await page.locator('.task-workflow').evaluate(n=>n.open),true);}finally{await context.close();dom.window.close();}
 }
 if(process.env.CICADA_DIALOG_EVIDENCE){fs.writeFileSync(process.env.CICADA_DIALOG_EVIDENCE,JSON.stringify({level:'Headless Edge with real shared dialog factory/CSS and synthetic body; not populated app/native',measurements},null,2));}
 }finally{await browser.close();}
});
