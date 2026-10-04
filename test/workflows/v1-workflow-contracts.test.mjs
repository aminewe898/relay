import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateV1Configuration,validateV1Claim,prepareV1Delivery,classifyV1Delivery} from './v1-workflow-contracts.mjs';
const config={configVersion:'FAKE',botId:'990000000001',operatorUserId:'990000000002',operatorChatId:'990000000002',
 ingressPolicy:{requirePrivateChat:true,requireHumanSender:true},retryPolicy:{blindWriteRetries:false,stageMaxAttempts:5},priorityPolicy:{unknownDefault:'normal',criticalRequiresConfirmation:true}};
const claim={outboxId:'11111111-1111-4111-8111-111111111111',leaseToken:'22222222-2222-4222-8222-222222222222'};
test('configuration fail closed; nonsecret IDs only',()=>{assert.deepEqual(validateV1Configuration(config),{botId:config.botId,operatorUserId:config.operatorUserId,operatorChatId:config.operatorChatId});for(const k of ['botId','operatorUserId','operatorChatId'])assert.throws(()=>validateV1Configuration({...config,[k]:null}));});
test('claim must carry bounded fenced contract',()=>{assert.equal(validateV1Claim({outcome:'idle'},'work').claimed,false);assert.equal(validateV1Claim({outcome:'claimed',...claim,attemptCount:1},'outbox').claimed,true);assert.throws(()=>validateV1Claim({outcome:'claimed'},'outbox'));});
test('message content safely escaped; cross-chat delivery denied',()=>{
 const r={outcome:'dispatch',...claim,chatId:config.operatorChatId,text:'A & B <admin> _markdown_',forceReply:true};
 assert.equal(prepareV1Delivery(r,claim,config).text,'A &amp; B &lt;admin&gt; _markdown_');assert.throws(()=>prepareV1Delivery({...r,chatId:'1'},claim,config));
});
test('native Telegram success wrapper only; matching authorized chat',()=>{
 const r={ok:true,result:{message_id:7001,chat:{id:Number(config.operatorChatId)}}};assert.equal(classifyV1Delivery(r,config.operatorChatId).messageId,'7001');
 assert.equal(classifyV1Delivery({message_id:7001},config.operatorChatId).classification,'delivery_unknown');
 assert.equal(classifyV1Delivery({...r,result:{message_id:7001,chat:{id:1}}},config.operatorChatId).classification,'delivery_unknown');
});
test('structured rejection classification; unknown transport cannot trigger resend',()=>{
 for(const code of [401,403])assert.equal(classifyV1Delivery({error:{httpCode:String(code)}},'1').classification,'configuration');
 for(const code of [400,404])assert.equal(classifyV1Delivery({ok:false,error_code:code},'1').classification,'permanent_external');
 const rate=classifyV1Delivery({ok:false,error_code:429,parameters:{retry_after:60}},'1');assert.equal(rate.classification,'rate_limited');assert.equal(rate.delaySeconds,60);
 assert.equal(classifyV1Delivery({ok:false,error_code:503},'1').classification,'rejected_transient');
 for(const r of [{error:{httpCode:503}},{error:{code:'ECONNRESET'}},{error:{code:'ETIMEDOUT'}},{error:'unknown secret-like provider text'},{},{error:{httpCode:408}}]){
   const c=classifyV1Delivery(r,'1');assert.equal(c.classification,'delivery_unknown');assert.deepEqual(Object.keys(c).sort(),['classification','delaySeconds','messageId']);
 }
});
test('narrow string fallback; structured evidence takes precedence',()=>{
 assert.equal(classifyV1Delivery({error:'Too Many Requests: retry after 60'},'1').classification,'rate_limited');
 assert.equal(classifyV1Delivery({error:'Unauthorized'},'1').classification,'configuration');
 assert.equal(classifyV1Delivery({error:'Bad Request: chat not found'},'1').classification,'permanent_external');
 assert.equal(classifyV1Delivery({error:'contains Unauthorized embedded arbitrary text'},'1').classification,'delivery_unknown');
 assert.equal(classifyV1Delivery({statusCode:500,error:'Unauthorized'},'1').classification,'delivery_unknown');
});
