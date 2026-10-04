import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const binary=fileURLToPath(new URL('../node_modules/next/dist/bin/next',import.meta.url));
const base='http://127.0.0.1:3111';
async function withServer(mode,verify){
  const env={...process.env,SERVICE_DESK_MODE:mode,SERVICE_DESK_TRANSPORT:'pg',SERVICE_DESK_DATABASE_URL:'',SERVICE_DESK_AUTH_USER:mode==='live'?'test-reader':'',SERVICE_DESK_AUTH_PASSWORD:mode==='live'?'synthetic-test-password':''};
  const child=spawn(process.execPath,[binary,'start','--hostname','127.0.0.1','--port','3111'],{cwd:root,env,stdio:'ignore',windowsHide:true});
  try{let ready=false;for(let i=0;i<70;i++){if(child.exitCode!==null)throw new Error('Loopback server exited');try{await fetch(base,{signal:AbortSignal.timeout(500)});ready=true;break;}catch{await delay(200);}}assert.equal(ready,true);await verify();}
  finally{const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed;}
}
await withServer('disconnected',async()=>{
  const response=await fetch(`${base}/api/v1/snapshot`);assert.equal(response.status,503);const data=await response.json();assert.equal(data.source,'disconnected');assert.equal(data.tickets.length,0);assert.match(response.headers.get('cache-control'),/no-store/);
  for(const path of ['/','/tickets','/customers','/automations','/assets','/settings']){const page=await fetch(`${base}${path}`);assert.equal(page.status,200);const html=await page.text();assert.match(html,/Backend unavailable/);assert.doesNotMatch(html,/Product preview|Make room for real work|Demo workspace|demo-ticket/);}
  assert.equal((await fetch(`${base}/api/v1/tickets`)).status,503);
  console.log('PASS disconnected mode, real empty/error pages, no runtime demo records');
});
await withServer('live',async()=>{
  for(const path of ['/','/api/v1/tickets','/api/v1/clients','/api/v1/activity','/api/v1/automation-health'])assert.equal((await fetch(`${base}${path}`)).status,401);
  const headers={authorization:`Basic ${Buffer.from('test-reader:synthetic-test-password').toString('base64')}`};
  assert.equal((await fetch(`${base}/api/v1/tickets`,{headers})).status,503);
  assert.equal((await fetch(`${base}/api/v1/tickets?sort=unsafe`,{headers})).status,400);
  assert.equal((await fetch(`${base}/api/v1/tickets?limit=9999`,{headers})).status,400);
  assert.equal((await fetch(`${base}/api/v1/tickets/not-a-uuid`,{headers})).status,400);
  const assets=await fetch(`${base}/api/v1/assets`,{headers});assert.equal(assets.status,501);assert.equal((await assets.json()).supported,false);
  assert.equal((await fetch(`${base}/api/v1/tickets`,{headers,method:'POST'})).status,405);
  console.log('PASS live auth, unavailable backend, filter/ID validation, unsupported assets, rejected writes');
});
