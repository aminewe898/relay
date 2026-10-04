import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyStageFailure} from './phase2a-classifier.mjs';

for (const [status, expected] of [[401,'configuration'],[403,'configuration'],[408,'transient_external'],
  [429,'transient_external'],[500,'transient_external'],[503,'transient_external'],[400,'permanent_external'],[404,'permanent_external']]) {
  test('structured HTTP '+status+' -> '+expected,()=>{
    assert.equal(classifyStageFailure({error:{httpCode:String(status)}}),expected);
    assert.equal(classifyStageFailure({error:{response:{statusCode:status}}}),expected);
    assert.equal(classifyStageFailure({error:{response:{body:{error_code:status}}}}),expected);
  });
}
for(const code of ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET']) {
  test('explicit transport '+code,()=>assert.equal(classifyStageFailure({error:{cause:{code}}}),'transient_external'));
}
test('legacy Telegram invalid-file signature -> permanent_external',()=>{
  assert.equal(classifyStageFailure({error:'Bad Request: wrong file identifier/HTTP URL specified'},{telegramLegacy:true}),'permanent_external');
});
test('unknown string-only provider failure -> operator review',()=>{
  assert.equal(classifyStageFailure({error:'FAKE_UNKNOWN_PROVIDER_ERROR'},{telegramLegacy:true}),'provider_unknown_result');
});
test('missing status is never inferred to be a connection failure',()=>{
  for(const input of [{},{error:{}},{error:{message:'FAKE_UNKNOWN'}},{error:null}])assert.equal(classifyStageFailure(input),'provider_unknown_result');
});
test('existing validated failure classification has first priority',()=>{
  assert.equal(classifyStageFailure({failure:{classification:'invalid_input',delaySeconds:1},error:{httpCode:503}}),'invalid_input');
  assert.equal(classifyStageFailure({failure:{classification:'configuration',extra:'not_validated'},error:{httpCode:503}}),'transient_external');
});
test('structured HTTP status outranks conflicting code/message evidence',()=>{
  assert.equal(classifyStageFailure({error:{httpCode:401,code:'ECONNRESET',message:'FAKE'}}),'configuration');
  assert.equal(classifyStageFailure({httpCode:503,error:'Bad Request: wrong file identifier/HTTP URL specified'},{telegramLegacy:true}),'transient_external');
});
test('structured unknown code forbids Telegram string fallback',()=>{
  assert.equal(classifyStageFailure({code:'FAKE_UNRECOGNIZED_CODE',error:'Bad Request: wrong file identifier/HTTP URL specified'},{telegramLegacy:true}),'provider_unknown_result');
});
test('legacy allowlist is scoped, anchored and narrow',()=>{
  assert.equal(classifyStageFailure({error:'Unauthorized'},{telegramLegacy:true}),'configuration');
  assert.equal(classifyStageFailure({error:'Too Many Requests: retry after 12'},{telegramLegacy:true}),'transient_external');
  for(const error of ['prefix Bad Request: invalid file_id','Bad Request: unknown new rejection','please retry Too Many Requests: retry after 12'])assert.equal(classifyStageFailure({error},{telegramLegacy:true}),'provider_unknown_result');
  assert.equal(classifyStageFailure({error:'Bad Request: invalid file_id'},{telegramLegacy:false}),'provider_unknown_result');
});
test('exact replacement Code wrapper uses bounded sanitized output only',async()=>{
  const w=JSON.parse(readFileSync(new URL('../../n8n/workflows/TI-02-intake-worker.json',import.meta.url),'utf8'));
  const code=w.nodes.find(n=>n.name==='Classify Stage Failure').parameters.jsCode;
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const fn=new AsyncFunction('$input','$',code);
  const work={workId:'FAKE_WORK',leaseToken:'FAKE_LEASE',revision:'1',stage:'download',attemptCount:2};
  const $=name=>({isExecuted:['Verify Begun Stage','Download Telegram Voice'].includes(name),first:()=>({json:{work}})});
  const raw={error:'Bad Request: invalid file_id',secret:'FAKE_SECRET_DO_NOT_COPY'};
  const [result]=await fn({first:()=>({json:raw})},$);
  assert.equal(result.json.classification,'permanent_external');
  assert.ok(result.json.delaySeconds>=1&&result.json.delaySeconds<=3600);
  assert.deepEqual(Object.keys(result.json).sort(),['classification','delaySeconds','work']);
  assert.equal(JSON.stringify(result).includes('FAKE_SECRET_DO_NOT_COPY'),false);
  assert.equal(JSON.stringify(result).includes(raw.error),false);
});
