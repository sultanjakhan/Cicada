/* Bounded hosted check: production workspace, notice, and CSS; synthetic IPC. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.local/controls1eeb-render');fs.mkdirSync(output,{recursive:true});
// Reuse the existing public workspace fixture rather than reconstructing its data.
const source=fs.readFileSync(path.join(root,'scripts/qa-goals85-render.cjs'),'utf8');
let fixture=new Function(source.slice(source.indexOf('const fixture ='),source.indexOf('const server ='))+'return fixture;')();
const backend=new Function('return '+source.slice(source.indexOf('function syntheticBackend'),source.indexOf('async function main()')))();
const mobileHeader=fs.readFileSync(path.join(root,'src/index.html'),'utf8').match(/  <div id="mobile-header">[\s\S]*?  <\/div>/)[0];
fixture=fixture.replace('<div id="app-body">','<div id="app-body">'+mobileHeader);
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
async function main(){await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:process.env.GOALS85_CHROME});const evidence=[];
 try{for(const width of [1100,390])for(const theme of ['light','dark']){
  const mobile=width===390,page=await browser.newPage({viewport:{width,height:844},...(mobile?{userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36',isMobile:true,hasTouch:true}:{})});
  const errors=[];page.on('pageerror',e=>{errors.push(e.message);fs.writeFileSync(path.join(output,width+'-'+theme+'-errors.json'),JSON.stringify(errors));});await page.addInitScript(backend,{theme});await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.fixtureReady);
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);assert.equal(await page.locator('html').evaluate(n=>n.classList.contains('mobile')),mobile);
  const themeButton=page.locator(mobile?'#mobile-header .calendar-theme-control':'.uni-header .calendar-theme-control');await themeButton.waitFor({state:'visible'});
  const themeBox=await themeButton.boundingBox();assert.ok(themeBox.width>=48&&themeBox.height>=48);
  if(!mobile){const title=await page.locator('.uni-header-name').boundingBox();assert.ok(themeBox.x>title.x+title.width-1);}
  const analogous=await page.locator('.uni-header-action,.calendar-day-banner button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({text:n.textContent.trim(),height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width,radius:getComputedStyle(n).borderRadius})));
  await page.screenshot({path:path.join(output,width+'-'+theme+'-dashboard.png')});
  await page.locator('.uni-tab[data-pane="tasks"]').click();const search=page.locator('[data-tasks-search]');await search.focus();
  analogous.push(...await page.locator('.ct-run').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({text:n.textContent.trim(),height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width,radius:getComputedStyle(n).borderRadius}))));
  fs.writeFileSync(path.join(output,width+'-'+theme+'-analogous.json'),JSON.stringify(analogous,null,2));
  await page.evaluate(async()=>{
   const {createSoftUpdateNotice}=await import('/src/hanni/js/app-update-notice.js');window.offerSafe=true;window.offerCalls=[];
   window.offer=createSoftUpdateNotice(window,{safe:()=>window.offerSafe,invoke:(command,args)=>{window.offerCalls.push({command,args});return new Promise(resolve=>{window.finishOffer=resolve;});}});
   window.offer.show({configured:true,phase:'available',version:'9.8.7'});
  });assert.equal(await search.evaluate(n=>n===document.activeElement),true,'offer must not steal focus');
  const offer=page.locator('.calendar-soft-update'),install=offer.locator('[data-soft-update-install]'),later=offer.locator('[data-soft-update-later]');
  const geometry=await offer.evaluate(n=>{const box=x=>{const b=x.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,centerY:b.y+b.height/2};};return{offer:box(n),icon:box(n.querySelector('.calendar-soft-update-icon')),title:box(n.querySelector('.calendar-soft-update-title')),buttons:[...n.querySelectorAll('button')].map(b=>({...box(b),radius:getComputedStyle(b).borderRadius})),scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth};});
  assert.ok(Math.abs(geometry.offer.x+geometry.offer.width/2-width/2)<=1);assert.ok(Math.abs(geometry.offer.y+geometry.offer.height/2-844/2)<=1);assert.ok(Math.abs(geometry.icon.centerY-geometry.title.centerY)<=1,'icon and title aligned');assert.ok(geometry.scrollWidth<=width);for(const b of geometry.buttons){assert.ok(b.height>=48&&b.width>=48);assert.ok(parseFloat(b.radius)>0);}
  if(mobile){const targets=await page.locator('.uni-header-action,.uni-tab').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({text:n.textContent,height:n.getBoundingClientRect().height})));for(const target of targets)assert.ok(target.height>=48,JSON.stringify(target));}
  await page.evaluate(()=>{window.offerSafe=false;window.offer.refresh();});assert.equal(await install.isDisabled(),true);assert.equal(await later.isDisabled(),false);assert.equal(await page.evaluate(()=>window.offerCalls.length),0);
  await page.screenshot({path:path.join(output,width+'-'+theme+'-disabled.png')});
  await page.evaluate(()=>{window.offerSafe=true;window.offer.refresh();});await install.focus();await page.keyboard.press('Tab');assert.equal(await later.evaluate(n=>n===document.activeElement),true);await page.keyboard.press('Shift+Tab');assert.equal(await install.evaluate(n=>n===document.activeElement),true);
  const focus=await install.evaluate(n=>({style:getComputedStyle(n).outlineStyle,width:getComputedStyle(n).outlineWidth}));assert.equal(focus.style,'solid');assert.ok(parseFloat(focus.width)>=2);
  await page.screenshot({path:path.join(output,width+'-'+theme+'-focus.png')});await page.keyboard.press('Enter');await page.waitForFunction(()=>window.offerCalls.length===1);assert.equal(await install.isDisabled(),true);assert.equal(await later.isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.offerCalls),[{command:'mvp_update_install',args:{expectedVersion:'9.8.7'}}]);await page.evaluate(()=>window.finishOffer({configured:true,phase:'installer_opened',version:'9.8.7'}));await page.waitForFunction(()=>!document.querySelector('[data-soft-update-later]').disabled);await later.click();await offer.waitFor({state:'detached'});
  await page.evaluate(()=>window.offer.show({configured:true,phase:'available',version:'9.8.7'}));assert.equal(await offer.count(),0);assert.deepEqual(errors,[]);
  evidence.push({width,theme,mobile,analogous,geometry,focus,noFocusSteal:true,explicitInstall:true,laterDismissal:true,cleanup:true});await page.close();
 }}finally{fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));await browser.close();server.close();}console.log(JSON.stringify(evidence));}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
