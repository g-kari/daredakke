import { test, expect } from '@playwright/test';
const origin='http://127.0.0.1:4317';
async function start(page){
 const violations=[];page.on('pageerror',e=>violations.push(e.message));
 await page.addInitScript(()=>{
  const namespace='u_'+'a'.repeat(64),data={people:[{id:'synthetic-person',name:'Synthetic export friend',aliases:[],tags:[],notes:'Synthetic only',color:'#4f5fcb'}],accounts:[]};
  const gates=window.__exportCopies=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>new Promise((resolve,reject)=>gates.push({text,resolve,reject}))}});
  const original=window.fetch.bind(window);
  window.fetch=async(input,options={})=>{
   const url=new URL(typeof input==='string'?input:input.url,location.href);
   if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return original(input,options);
   if((options.method||'GET')!=='GET')throw Error('Unexpected synthetic write');
   if(url.pathname==='/api/session')return Response.json({namespace});
   if(url.pathname==='/api/records')return Response.json({namespace,revision:0,state:{data,undo:[]}});
   throw Error('Unexpected synthetic API');
  };
 });
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin||route.request().method()!=='GET'||u.pathname.startsWith('/api/')){violations.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto('/');await expect(page.getByText('保存済み',{exact:true})).toBeVisible();
 return violations;
}
const dialog=page=>page.getByRole('dialog',{name:'JSONを書き出す',exact:true});
async function open(page){await page.getByRole('button',{name:'JSONを書き出す',exact:true}).click();await expect(dialog(page)).toBeVisible();}
async function settle(page,index,success=true){await page.evaluate(({index,success})=>{const gate=window.__exportCopies[index];if(success)gate.resolve();else gate.reject(Error('Synthetic clipboard rejection'));},{index,success});}
test('closed/reopened export ignores late clipboard success then current copy succeeds',async({page},testInfo)=>{
 const violations=await start(page);await open(page);await dialog(page).getByRole('button',{name:'コピー',exact:true}).click();
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await open(page);await settle(page,0);
 await expect(dialog(page).getByRole('button',{name:'コピー',exact:true})).toBeVisible();await expect(page.getByText('JSONをコピーしました',{exact:true})).toHaveCount(0);
 await dialog(page).getByRole('button',{name:'コピー',exact:true}).click();await settle(page,1);await expect(dialog(page).getByRole('button',{name:'コピー済み',exact:true})).toBeVisible();
 await testInfo.attach('current-copy',{body:await page.screenshot(),contentType:'image/png'});expect(violations).toEqual([]);
});
test('failed latest copy clears old badge and ignores an older success',async({page},testInfo)=>{
 const violations=await start(page);await open(page);await dialog(page).getByRole('button',{name:'コピー',exact:true}).click();await settle(page,0);await dialog(page).getByRole('button',{name:'コピー済み',exact:true}).click();
 await expect(dialog(page).getByRole('button',{name:'コピー',exact:true})).toBeVisible();await dialog(page).getByRole('button',{name:'コピー',exact:true}).click();await settle(page,2,false);await settle(page,1);
 await expect(dialog(page).getByRole('button',{name:'コピー',exact:true})).toBeVisible();await expect(page.getByText('コピーできませんでした。テキストを選択してコピーしてください。',{exact:true})).toBeVisible();
 await testInfo.attach('failed-copy-recovery',{body:await page.screenshot(),contentType:'image/png'});expect(violations).toEqual([]);
});
