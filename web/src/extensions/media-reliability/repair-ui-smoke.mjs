import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
const artifactDir = process.env.EXT_MEDIA_RELIABILITY_ARTIFACT_DIR || path.join(tmpdir(), 'huabu-repair-smoke');
fs.mkdirSync(artifactDir, { recursive: true });
const artifact = name => path.join(artifactDir, name);
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.EXT_MEDIA_RELIABILITY_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true, executablePath:process.env.EXT_MEDIA_RELIABILITY_CHROMIUM || undefined});
const context = await browser.newContext({ viewport:{width:1038,height:912} });
const user = {id:'repair-fixture',username:'fixture',displayName:'Fixture',role:'admin',credits:100,avatarUrl:'',createdAt:'',updatedAt:''};
const models = ['gpt-5.5','gemini-3.1-pro-preview','gpt-image-1','wan3.0-image','sora-2'];
const channel = {id:'fixture',name:'Test channel with a long name',protocol:'newapi',baseUrl:'https://fixture.invalid',apiKey:'fixture-only',models,enabled:true,weight:1,timeout:600};
const config = {channelMode:'local',localChannels:[channel],models,textModel:'gpt-5.5',textChannelId:'fixture',imageModel:'gpt-image-1',imageChannelId:'fixture',videoModel:'sora-2',videoChannelId:'fixture',model:'gpt-image-1',apiMode:'images'};
const providers = ['火山 TOS','七牛云'].map((name,index)=>({id:'oss-'+index,type:'s3',name,enabled:true,endpoint:'https://s3.fixture.invalid',region:'fixture',bucket:'test-'+index,accessKeyId:'fixture',secretAccessKey:'',weight:1}));
const requests=[];
const histories = new Map();
const imageTasks = new Map();
const videoTasks = new Map();
let storageOnline=false,historyOnline=false,deleteOnline=false;
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=';
const project={id:'fixture',title:'Fixture Canvas',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nodes:[{id:'fixture-node',type:'image',title:'生成图片',position:{x:100,y:100},width:240,height:240,metadata:{content:png,status:'success',prompt:'A fixture image',model:'gpt-image-1',naturalWidth:240,naturalHeight:240}}],connections:[],chatSessions:[],activeChatId:null,agentConfig:null,autoTitlePending:false,backgroundMode:'dots',showImageInfo:true,viewport:{x:0,y:0,k:1},sidePanel:{open:false,width:280},agentPanel:{open:true,width:400}};
await context.route('**/api/**', async route=>{
 const req=route.request(), path=new URL(req.url()).pathname;
 requests.push({method:req.method(),path,body:req.postData()?.slice(0,1000)});
 if(path==='/api/v1/videos'&&req.method()==='POST') {
  const id='fixture-video-'+videoTasks.size;
  const task={id,status:'completed',progress:100,video_url:'/fixture.mp4',model:'sora-2',created_at:Math.floor(Date.now()/1000)};
  videoTasks.set(id,task);
  return route.fulfill({json:{code:0,data:task}});
 }
 if(path.startsWith('/api/v1/videos/')) return route.fulfill({json:{code:0,data:[...videoTasks.values()][0]}});
 if(path==='/api/v1/canvas/image-tasks'&&req.method()==='POST') {
  const body=req.postDataJSON(), id=body.clientTaskId;
  const task={id,status:'completed',progress:100,image_url:png,width:1,height:1,mimeType:'image/png',source:'image-workbench',source_id:body.sourceId,createdAt:new Date().toISOString()};imageTasks.set(id,task);
  return route.fulfill({json:{code:0,data:task}});
 }
 if(path==='/api/v1/canvas/image-tasks/status') return route.fulfill({json:{code:0,data:[...imageTasks.values()]}});
 if(path==='/api/v1/files'&&req.method()==='POST') return route.fulfill(storageOnline?{json:{code:0,data:{url:'/fixture.png',storageKey:'server:fixture-image',bytes:70,mimeType:'image/png',width:1,height:1}}}:{status:503,json:{code:1,msg:'Fixture storage offline'}});
 if(path==='/api/v1/generation-logs/images'||path==='/api/v1/generation-logs/videos') {
  if(req.method()==='POST') {
   if(!historyOnline) return route.fulfill({status:503,json:{code:1,msg:'Fixture history offline'}});
   req.postDataJSON().logs.forEach(x=>histories.set(x.id,x));
  }
  return route.fulfill({json:{code:0,data:[...histories.values()]}});
 }
 if(req.method()==='DELETE'||path.endsWith('/delete')) return route.fulfill(deleteOnline?{json:{code:0,data:{deleted:true}}}:{status:503,json:{code:1,msg:'Fixture delete offline'}});
 let data={};
 if(path==='/api/auth/me') data=user;
 else if(path==='/api/extensions/model-policy') data={imageTransfer:'url',overrides:{},newapiVideoProfiles:{}};
 else if(path==='/api/v1/canvas/projects') data=process.argv[2]?.startsWith('/canvas/')?[project]:[];
 else if(path==='/api/settings') data={modelChannel:{enabled:true,availableModels:models,allowUserRemoteChannel:true,channels:[channel],modelCosts:[],systemPrompt:'',systemPrompts:{image:'',video:'',text:'',audio:'',workflow:'',workflowAgent:''}},site:{}};
 else if(path==='/api/v1/user-config') data={modelConfig:config,syncCapabilities:{userData:false}};
 else if(path==='/api/admin/settings') data={public:{modelChannel:{availableModels:models}},private:{channels:[channel],storage:{providers}}};
 else if(path==='/api/extensions/storage-access') data=providers.map((p,index)=>({...p,config:{allowedOrigins:[],delivery:'s3',cdnBaseUrl:'',tokenKey:'',hasTokenKey:false,defaultUpload:index===0}}));
 else if(path==='/api/agent-skills') data=[{id:'test-skill',name:'联调 Skill',description:'用于测试弹层选择',source:'system',content:'test',enabled:true}];
 else if(path==='/api/v1/agent-skills') data=[{id:'user-skill',name:'我的测试 Skill',description:'编辑测试',source:'user',content:'test',enabled:true}];
 else if(path.includes('generation-logs')||path.includes('tasks')||path.includes('skills')||path.includes('channels')) data=[];
 else if(path.includes('prompts')||path.includes('assets')) data={items:[],total:0};
 else if(path.includes('storage/config')) data={mode:'server_sqlite_s3',allowUserProvider:false,allowUserGlobalProvider:true,autoSyncAllAssets:process.env.EXT_MEDIA_RELIABILITY_AUTO_SYNC==='true'};
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:0,data})});
});
await context.route('**/fixture.mp4',route=>route.fulfill({contentType:'video/mp4',body:Buffer.from('fixture-invalid-video')}));
await context.addInitScript(({config})=>{
 localStorage.setItem('infinite-canvas-auth-token-v1',JSON.stringify({state:{token:'fixture-only'},version:0}));
 localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({state:{config},version:0}));
 localStorage.setItem('infinite-canvas:theme_store',JSON.stringify({state:{theme:'dark'},version:0}));
},{config});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
process.on('uncaughtException',async error=>{console.error(error.stack);console.log(JSON.stringify({requests,errors,body:(await page.locator('body').innerText()).slice(-5000)},null,2));await page.screenshot({path:artifact('huabu-ui-failure.png'),fullPage:true});await browser.close();process.exit(1);});
await page.goto((process.env.EXT_MEDIA_RELIABILITY_TEST_URL || 'http://127.0.0.1:3001')+(process.argv[2]||'/'),{waitUntil:'networkidle',timeout:120000});
console.log(JSON.stringify({url:page.url(),buttons:await page.getByRole('button').allTextContents(),comboboxes:await page.getByRole('combobox').evaluateAll(xs=>xs.map(x=>({text:x.textContent,label:x.getAttribute('aria-label')}))),editable:await page.locator('[contenteditable],textarea').evaluateAll(xs=>xs.map(x=>({tag:x.tagName,role:x.getAttribute('role'),placeholder:x.getAttribute('placeholder')}))),errors},null,2));
await page.screenshot({path:artifact('huabu-repair-ui.png'),fullPage:true});
if(!process.argv[2]) {
 const skillButton=page.getByRole('button',{name:'Skill',exact:true});
 const settingsButton=page.getByRole('button',{name:'工具设置',exact:true});
 const skillBox=await skillButton.boundingBox(), settingsBox=await settingsButton.boundingBox();
 assert.ok(skillBox.x>=settingsBox.x+settingsBox.width && Math.abs(skillBox.y-settingsBox.y)<8,'Skill must sit beside settings');
 await page.getByRole('button',{name:'Skill',exact:true}).click();
 const search=page.getByPlaceholder('搜索 Skill');
 await search.waitFor();
 const popup=page.getByRole('tooltip').filter({has:search});
 const parent=page.getByRole('dialog',{name:'工具设置'});
 assert.equal(await parent.count(),0);
 await search.fill('联调');
 assert.equal(await search.evaluate(el=>el===document.activeElement),true);
 await page.getByRole('button',{name:'联调 Skill 用于测试弹层选择'}).click();
 await search.waitFor({state:'hidden'});
 await settingsButton.click();
 assert.equal(await parent.getByRole('button',{name:'Skill',exact:true}).count(),0);
 assert.equal(await page.getByRole('switch',{name:'自动提交生成'}).getAttribute('aria-checked'),'false');
 await page.getByRole('switch',{name:'自动提交生成'}).click();
 assert.equal(await page.getByRole('switch',{name:'自动提交生成'}).getAttribute('aria-checked'),'true');
 await page.getByRole('button',{name:'关闭工具设置'}).click();
 await parent.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Skill',exact:true}).click();
 await page.getByRole('button',{name:'我的',exact:true}).click();
 await search.fill('');
 await page.getByRole('button',{name:'我的测试 Skill 编辑测试',exact:true}).hover();
 await page.getByRole('button',{name:'编辑 我的测试 Skill',exact:true}).click();
 const editor=page.getByRole('dialog',{name:'编辑 Skill'});
 await editor.getByLabel('名称',{exact:true}).fill('保留测试');
 assert.equal(await editor.isVisible(),true);
 await editor.getByRole('button',{name:/Close|关闭/}).click();
 await editor.waitFor({state:'hidden'});
 assert.equal(await parent.isVisible(),false);
 await page.getByRole('button',{name:'思考强度：关闭'}).click();
 await page.getByRole('menuitem',{name:'高',exact:true}).click();
 await page.getByRole('menu').waitFor({state:'hidden'});
 assert.equal(await page.getByRole('button',{name:'思考强度：高'}).count(),1);
 const box=await page.getByRole('textbox').boundingBox();
 await page.getByRole('combobox',{name:'文本模型'}).click();
 await page.getByRole('listbox').waitFor();
 await page.mouse.click(box.x+30,box.y+20);
 await page.getByRole('listbox').waitFor({state:'hidden',timeout:4000});
 assert.equal(await page.getByRole('textbox').evaluate(x=>x===document.activeElement),true);
 await page.getByRole('textbox').fill('Fixture');
 for(const width of [687,390]) {
  await page.setViewportSize({width,height:844});
  await page.screenshot({path:`${artifactDir}/huabu-home-${width}.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 console.log('home: effort, outside focus, 687/390 layout passed');
 await page.getByRole('button',{name:'Skill',exact:true}).click();
 await search.fill('手机');
 const mobilePopup=await popup.boundingBox();
 assert.ok(mobilePopup.x>=0 && mobilePopup.x+mobilePopup.width<=390,JSON.stringify(mobilePopup));
 await page.screenshot({path:artifact('huabu-skill-mobile.png'),fullPage:true});
 await page.keyboard.press('Escape');
 const guestContext=await browser.newContext();
 const guest=await guestContext.newPage();
 await guest.goto(process.env.EXT_MEDIA_RELIABILITY_TEST_URL||'http://127.0.0.1:3001',{waitUntil:'networkidle'});
 assert.equal(await guest.getByRole('combobox',{name:'文本模型'}).count(),0);
 assert.equal(await guest.getByRole('button',{name:'工具设置',exact:true}).count(),0);
 assert.equal(await guest.getByRole('button',{name:/思考强度/}).count(),0);
 await guestContext.close();
 console.log('home: independent Skill beside settings, tool controls and guest visibility passed');
}
if(process.argv[2]==='/image') {
 await page.getByRole('button',{name:'底部',exact:true}).click();
 await page.screenshot({path:artifact('huabu-image-bottom.png'),fullPage:true});
 console.log('workbench colors',await page.locator('[class*="workbench"]').evaluateAll(xs=>xs.map(x=>getComputedStyle(x).backgroundColor)));
 await page.getByText('chat',{exact:true}).click();
 await page.getByRole('combobox',{name:/^质量/}).waitFor({state:'hidden'});
 assert.equal(await page.getByRole('combobox',{name:/^质量/}).count(),0);
 assert.equal(await page.getByRole('combobox',{name:/^尺寸/}).count(),0);
 await page.getByText('images',{exact:true}).click();
 await page.getByRole('combobox',{name:/^质量/}).waitFor({state:'visible'});
 await page.locator('textarea').first().fill('A fixture image');
 await page.getByRole('button',{name:'开始创作',exact:true}).click();
 await page.getByText('云端保存失败',{exact:true}).first().waitFor({timeout:20000});
 assert.equal(imageTasks.size,1);
 await page.getByRole('button',{name:'重新同步',exact:true}).waitFor();
 historyOnline=true;
 const syncedHistory=page.waitForResponse(response=>response.url().endsWith('/api/v1/generation-logs/images')&&response.request().method()==='POST'&&response.status()===200);
 await page.getByRole('button',{name:'重新同步',exact:true}).click();
 await syncedHistory;
 await page.getByRole('button',{name:'重新同步',exact:true}).waitFor({state:'hidden'});
 assert.equal(histories.size,1);
 storageOnline=true;
 await page.getByRole('button',{name:'同步到云端存储',exact:true}).first().click();
 await page.getByRole('button',{name:'同步到云端存储',exact:true}).first().waitFor();
 await page.waitForTimeout(700);
 assert.equal(imageTasks.size,1);
 console.log('image: generation survives storage/sync failure; retry sends no new generation');
 assert.equal([...histories.values()][0].images[0].storageKey,'server:fixture-image');
 await page.screenshot({path:artifact('huabu-image-retry.png'),fullPage:true});
 await page.getByRole('button',{name:'全选',exact:true}).click();
 await page.getByRole('button',{name:'删除',exact:true}).first().click();
 await page.getByRole('dialog',{name:'删除生成记录'}).getByRole('button',{name:/删\s*除/}).click();
 await page.getByText('Fixture delete offline',{exact:true}).waitFor();
 assert.equal(histories.size,1);
 assert.equal(await page.getByRole('dialog',{name:'删除生成记录'}).isVisible(),true);
 console.log('image: failed deletion retains history and reports failure');
}
if(process.argv[2]==='/admin/settings') {
 await page.getByRole('tab',{name:'私有配置（不会对外暴露）',exact:true}).click();
 await page.getByText('云存储与访问',{exact:true}).waitFor();
 await page.getByText('云存储与访问',{exact:true}).scrollIntoViewIfNeeded();
 console.log('private controls',await page.getByRole('button').allTextContents());
 await page.getByRole('combobox',{name:'文件读取方式'}).first().click();
 await page.getByText('阿里 ESA（Type A）',{exact:true}).last().click();
 assert.equal(await page.getByText('ESA Type A 密钥',{exact:true}).count(),1);
 await page.getByRole('radio',{name:'默认上传位置',exact:true}).nth(1).check();
 assert.equal(await page.getByRole('radio',{name:'默认上传位置',exact:true}).nth(0).isChecked(),false);
 for(const width of [1038,390]) {
  await page.setViewportSize({width,height:912});
  await page.waitForTimeout(400);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow) console.log('overflow elements',await page.locator('body *').evaluateAll(xs=>xs.filter(x=>x.getBoundingClientRect().right>innerWidth+2&&!x.closest('.ant-table-content')&&getComputedStyle(x).display!=='none').slice(0,35).map(x=>({tag:x.tagName,class:x.className,rect:x.getBoundingClientRect().toJSON(),text:x.textContent?.slice(0,60)}))));
  assert.equal(overflow,false);
  console.log('table boundaries',await page.locator('.ant-table-content').evaluateAll(xs=>xs.map(x=>({width:x.clientWidth,scroll:x.scrollWidth,left:x.getBoundingClientRect().left,right:x.getBoundingClientRect().right}))));
  await page.screenshot({path:`${artifactDir}/huabu-admin-${width}.png`,fullPage:true});
 }
 console.log('admin: default radio, ESA fields, desktop/mobile boundaries passed');
}
if(process.argv[2]?.startsWith('/canvas/')) {
 await page.locator('.node-element').first().waitFor();
 console.log('node',await page.locator('.node-element').first().evaluate(x=>({rect:x.getBoundingClientRect().toJSON(),children:Array.from(x.children).map(c=>({border:getComputedStyle(c).borderColor,text:c.textContent?.slice(0,80)}))})));
 await page.locator('.node-element').first().click();
 const toolbar=await page.locator('[data-canvas-hover-tools]').boundingBox();
 assert.ok(toolbar.y>=64&&toolbar.x>=0&&toolbar.x+toolbar.width<=638);
 await page.screenshot({path:artifact('huabu-canvas.png'),fullPage:true});
 console.log('canvas controls',await page.getByRole('button').allTextContents());
 const input=page.locator('[contenteditable="true"]').last();
 const box=await input.boundingBox();
 await page.getByRole('combobox',{name:'图片模型'}).click();
 await page.getByRole('listbox').waitFor();
 await page.mouse.click(box.x+20,box.y+20);
 await page.getByRole('listbox').waitFor({state:'hidden'});
 assert.equal(await input.evaluate(x=>x===document.activeElement),true);
 console.log('canvas: nested picker first outside click closes and focuses prompt');
 await page.getByRole('button',{name:'查看节点信息',exact:true}).click();
 const info=page.locator('.canvas-node-info-modal');
 await info.waitFor({state:'visible'});
 const topmost=await info.evaluate(modal=>{
  const rect=modal.getBoundingClientRect();
  return [0.25,0.5,0.85].every(y=>[0.25,0.75].every(x=>modal.contains(document.elementFromPoint(rect.x+rect.width*x,rect.y+rect.height*y))));
 });
 assert.equal(topmost,true,'node information must cover the prompt composer at every sampled point');
 await info.getByText('JSON',{exact:true}).click();
 await info.locator('pre').waitFor({state:'visible'});
 await page.screenshot({path:artifact('huabu-node-info-topmost.png'),fullPage:true});
 await info.locator('.ant-modal-close').click();
 await info.waitFor({state:'hidden'});
 console.log('canvas: node information stays above prompt composer and JSON/close work');
}
if(process.argv[2]==='/video') {
 const customSeconds=page.getByRole('spinbutton',{name:'自定义秒数',exact:true});
 assert.equal(await customSeconds.getAttribute('max'),'30');
 await customSeconds.fill('30');
 await customSeconds.blur();
 assert.equal(await customSeconds.inputValue(),'30');
 await customSeconds.fill('31');
 await customSeconds.blur();
 assert.equal(await customSeconds.inputValue(),'30');
 await page.getByRole('button',{name:'底部',exact:true}).click();
 for(const width of [1038,390]) {
  await page.setViewportSize({width,height:912});
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`${artifactDir}/huabu-video-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:1038,height:912});
 await page.locator('textarea').first().fill('A fixture video');
 await page.getByRole('button',{name:'开始创作',exact:true}).click();
 await page.getByText('云端保存失败',{exact:true}).first().waitFor({timeout:30000});
 assert.equal(videoTasks.size,1);
 assert.equal(JSON.parse(requests.find(request=>request.path==='/api/v1/videos'&&request.method==='POST').body).seconds,'30');
 console.log('video: result survives storage failure');
 console.log('video controls',await page.getByRole('button').allTextContents());
 historyOnline=true;
 await page.getByRole('button',{name:'重新同步',exact:true}).click();
 await page.getByRole('button',{name:'重新同步',exact:true}).waitFor({state:'hidden'});
 storageOnline=true;
 const syncedVideo=page.waitForResponse(response=>response.url().endsWith('/api/v1/generation-logs/videos')&&response.request().method()==='POST'&&response.request().postData()?.includes('server:fixture-image'));
 await page.getByRole('button',{name:'同步到云端存储',exact:true}).first().click();
 await page.getByText('云端存储',{exact:true}).first().waitFor();
 await syncedVideo;
 assert.equal(videoTasks.size,1);
 assert.equal([...histories.values()][0].video.storageKey,'server:fixture-image');
 console.log('video: retry saves existing result without a second generation');
}
if(process.argv[2]==='/director/index.html') {
 await page.getByRole('button',{name:'导演视角',exact:true}).waitFor({state:'visible'});
 assert.equal(await page.getByRole('button',{name:'打开 GitHub',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'关闭',exact:true}).isVisible(),true);
 await page.getByRole('button',{name:'机位视角',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'机位视角',exact:true}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:artifact('huabu-director-no-github.png'),fullPage:true});
 console.log('director: GitHub entry hidden, close and camera mode remain available');
}
console.log(JSON.stringify({requestCount:requests.length,errors,artifactDir}));
assert.equal(errors.length,0);
await browser.close();
