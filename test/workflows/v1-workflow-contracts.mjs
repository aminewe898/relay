// Pure contracts. Raw Telegram errors/content are never returned from these helpers.
export function validateV1Configuration(c) {
 const positive=v=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v)&&Number.isSafeInteger(Number(v));
 if(!c||typeof c.configVersion!=='string'||!c.configVersion||!positive(c.botId)||!positive(c.operatorUserId)||!positive(c.operatorChatId)||
   c.ingressPolicy?.requirePrivateChat!==true||c.ingressPolicy?.requireHumanSender!==true||c.retryPolicy?.blindWriteRetries!==false||
   !Number.isInteger(c.retryPolicy?.stageMaxAttempts)||c.retryPolicy.stageMaxAttempts<1||c.retryPolicy.stageMaxAttempts>20||
   !['low','normal','high','critical'].includes(c.priorityPolicy?.unknownDefault)||c.priorityPolicy?.criticalRequiresConfirmation!==true)
   throw new Error('invalid_v1_configuration');
 return {botId:c.botId,operatorUserId:c.operatorUserId,operatorChatId:c.operatorChatId};
}
export function validateV1Claim(r,kind) {
 if(!r||!['claimed','idle','needs_operator'].includes(r.outcome))throw new Error('uncertain_database_result');
 if(r.outcome!=='claimed')return {claimed:false,outcome:r.outcome};
 const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
 const key=kind==='outbox'?'outboxId':'workId';
 if(!uuid(r[key])||!uuid(r.leaseToken)||!Number.isInteger(r.attemptCount)||r.attemptCount<1||
   (kind==='work'&&!['resolve_client','operator_reply'].includes(r.stage)))throw new Error('uncertain_database_result');
 return {claimed:true,[key]:r[key],leaseToken:r.leaseToken};
}
export function prepareV1Delivery(r,claim,config) {
 if(r?.outcome!=='dispatch'||r.outboxId!==claim.outboxId||r.leaseToken!==claim.leaseToken||r.chatId!==config.operatorChatId||
   typeof r.text!=='string'||r.text.length<1||Array.from(r.text).length>3800||typeof r.forceReply!=='boolean')
   throw new Error('invalid_delivery_contract');
 // Telegram's native node defaults to Markdown. Explicit HTML plus escaping makes
 // extracted/operator text inert and preserves its visible characters.
 return {outboxId:r.outboxId,leaseToken:r.leaseToken,chatId:r.chatId,forceReply:r.forceReply,
   text:r.text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')};
}
export function classifyV1Delivery(input,expectedChat) {
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const number=v=>typeof v==='string'&&/^[1-5][0-9]{2}$/.test(v)?Number(v):v;
 const retry=v=>Number.isInteger(v)&&v>0?Math.min(3600,v):30;
 // Telegram REST returns {ok:true,result:{message_id,chat}}. No alternative wrapper.
 if(input?.ok===true&&Number.isSafeInteger(input.result?.message_id)&&input.result.message_id>0&&String(input.result.chat?.id)===expectedChat)
   return {messageId:String(input.result.message_id),classification:null,delaySeconds:30};
 const roots=[input,input?.error,input?.error?.cause,input?.error?.context,input?.error?.response,input?.error?.response?.body,input?.body,input?.response?.body].filter(object);
 let status=null;
 for(const key of ['statusCode','httpCode','status','error_code','code']){
   for(const r of roots){const s=number(r[key]);if(Number.isInteger(s)&&s>=100&&s<=599){status=s;break;}}
   if(status!==null)break;
 }
 let classification='delivery_unknown',delaySeconds=30;
 if(status===401||status===403)classification='configuration';
 else if(status===429){classification='rate_limited';delaySeconds=retry(roots.find(r=>r.parameters?.retry_after)?.parameters.retry_after);}
 else if(status>=400&&status<500&&status!==408)classification='permanent_external';
 else if(status>=500&&status<600&&roots.some(r=>r.ok===false))classification='rejected_transient';
 const structured=roots.some(r=>['statusCode','httpCode','status','error_code','code'].some(k=>r[k]!==undefined&&r[k]!==null&&r[k]!==''));
 if(!structured&&typeof input?.error==='string'&&input.error.length<=512){
   const s=input.error.trim();
   if(['Unauthorized','Forbidden','Forbidden: bot was blocked by the user','Authorization failed - please check your credentials'].includes(s))classification='configuration';
   else if(/^Too Many Requests: retry after [1-9][0-9]{0,5}$/.test(s)){classification='rate_limited';delaySeconds=retry(Number(s.split(' ').at(-1)));}
   else if(['Bad Request: chat not found','Bad Request: message text is empty','Bad Request: message is too long','Bad Request: not enough rights to send text messages to the chat'].includes(s))classification='permanent_external';
 }
 // Network failures, timeouts, missing evidence, malformed success and generic 5xx
 // all have unknown delivery outcome. No automatic resend is safe in these cases.
 return {messageId:null,classification,delaySeconds};
}
