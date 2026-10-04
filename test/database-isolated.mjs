// Fake-data PostgreSQL tests only. No n8n execution, no Telegram/provider requests.
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {classifyStageFailure} from './workflows/phase2a-classifier.mjs';
const container=globalThis.process.env.RELAY_TEST_CONTAINER;
if(!container||!/^relay-ci-[a-f0-9]+-postgres-1$/.test(container))throw new Error('Dedicated disposable relay-ci container required');
const labels=JSON.parse(execFileSync('docker',['inspect',container,'--format','{{json .Config.Labels}}'],{encoding:'utf8',windowsHide:true}));
if(!/^relay-ci-[a-f0-9]+$/.test(labels['com.docker.compose.project']||'')||labels['com.docker.compose.service']!=='postgres')throw new Error('Disposable PostgreSQL project labels required');
const db='ticket_hardening_test_'+randomUUID().replaceAll('-','');
const suffix=db.slice(-32),readRole='hard_read_'+suffix,adminRole='hard_admin_'+suffix;
const hash=x=>createHash('sha256').update(x).digest('hex');
const lit=x=>"'"+String(x).replaceAll("'","''")+"'";
const json=x=>lit(JSON.stringify(x))+'::jsonb';
const args=d=>['exec','-i',container,'psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-U','relay_bootstrap','-d',d];
const docker=(a,input)=>execFileSync('docker',a,{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});
const admin=q=>docker(args(db),q).trim();
const runtime=q=>admin('SET SESSION AUTHORIZATION ticket_n8n;\n'+q);
const result=q=>JSON.parse(runtime(q));
const inspect=q=>JSON.parse(admin(q));
const parallel=q=>new Promise((resolve,reject)=>{const p=spawn('docker',args(db),{windowsHide:true});let out='',err='';
 p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c?reject(new Error(err)):resolve(out.trim()));p.stdin.end('SET SESSION AUTHORIZATION ticket_n8n;\n'+q);});
const deny=(fn,code)=>{let e;try{fn();}catch(x){e=x;}assert.ok(e);assert.match(String(e.stderr??e.message),new RegExp('ERROR:\\s+'+code+':'));};
const baselineFingerprint=()=>hash(docker(['exec',container,'pg_dump','-U','relay_bootstrap','-d','ticket_system']).replace(/^\\(?:un)?restrict .*$/gm,''));
const roleFingerprint=()=>hash(docker(args('postgres'),`SELECT jsonb_agg(to_jsonb(r) ORDER BY rolname) FROM pg_roles r;`));
const rolesBefore=roleFingerprint();
const report={database:db,tests:[],externalRequests:0,sourceHashes:{},baselineBefore:baselineFingerprint()};
const bot=990000000001,user=990000000002,chat=user;
let seq=0,created=false;
const policy={configVersion:'FAKE_V1',retryPolicy:{stageMaxAttempts:5},priorityPolicy:{unknownDefault:'normal',criticalRequiresConfirmation:true}};
const extraction=(overrides={})=>({clientName:null,company:null,email:null,summary:'FAKE TEST incident',description:'FAKE TEST only: printer unavailable.',category:'hardware',prioritySuggestion:'unknown',affectedSystem:'FAKE printer',symptoms:[],technicalDetails:[],onsetText:null,businessImpact:null,urgencyEvidence:null,confidence:null,missingInformation:[],...overrides});
const reset=()=>{admin('UPDATE ticket_intake.backend_policy SET interaction_ttl_hours=48,audio_hard_ttl_hours=72,audio_success_grace_minutes=60;');return admin('SET ROLE ticket_owner;TRUNCATE ticket_intake.clients,ticket_intake.client_contacts,ticket_intake.processed_messages,ticket_intake.intakes,ticket_intake.pending_interactions,ticket_intake.tickets,ticket_intake.work_items,ticket_intake.outbox RESTART IDENTITY CASCADE;');};
const voice=(overrides={})=>{
 const n=++seq;
 const r=result(`SELECT ticket_intake.ingest_message(${bot},${n},${user},${chat},${n},'voice',${json({fileId:'FAKE_FILE_'+n,fileUniqueId:'FAKE_UNIQUE_'+n,mimeType:'audio/ogg',sizeBytes:20,durationSeconds:1})},${json(policy)});`);
 const e=extraction(overrides);
 admin(`SET ROLE ticket_owner;UPDATE ticket_intake.work_items SET status='succeeded',attempt_count=1 WHERE intake_id=${lit(r.intakeId)};
 INSERT INTO ticket_intake.work_items(intake_id,stage,status,max_attempts,attempt_count) VALUES(${lit(r.intakeId)},'transcribe','succeeded',5,1),(${lit(r.intakeId)},'extract','succeeded',5,1),(${lit(r.intakeId)},'resolve_client','queued',5,0);
 UPDATE ticket_intake.intakes SET state='extracted',revision=6,extraction=${json(e)},extraction_validated_at=clock_timestamp(),validation_version=1,
 transcript_original=${lit('FAKE transcript '+JSON.stringify(e))},transcribed_at=clock_timestamp(),
 extraction_metadata='{"provider":"groq","model":"openai/gpt-oss-120b","schemaVersion":"extraction-1","promptVersion":"extract-prompt-1"}',
 audio_bytes=convert_to('OggSFAKE TEST AUDIO','UTF8'),audio_sha256=encode(sha256(convert_to('OggSFAKE TEST AUDIO','UTF8')),'hex'),
 audio_size_bytes=octet_length(convert_to('OggSFAKE TEST AUDIO','UTF8')),audio_mime_type='audio/ogg',audio_stored_at=clock_timestamp(),audio_purge_after=clock_timestamp()+interval '72 hours'
 WHERE id=${lit(r.intakeId)};`);
 return r;
};
const text=(value,replyTo=null,identity={})=>{
 const n=++seq,m={text:value};if(replyTo)m.replyToMessageId=replyTo;
 return result(`SELECT ticket_intake.ingest_message(${identity.bot??bot},${n},${identity.user??user},${identity.chat??chat},${n},'text',${json(m)},${json(policy)});`);
};
const claimSQL=()=>`SELECT ticket_intake.claim_v1_work('FAKE_WORKER',${bot},${user},${chat});`;
const claim=()=>result(claimSQL());
const processSQL=w=>`SELECT ticket_intake.process_v1_work(${lit(w.workId)},${lit(w.leaseToken)});`;
const process=w=>result(processSQL(w));
const run=()=>{const w=claim();assert.equal(w.outcome,'claimed');return {w,r:process(w)};};
const state=()=>inspect(`SELECT jsonb_build_object('intakes',(SELECT coalesce(jsonb_agg(to_jsonb(i)-'audio_bytes' ORDER BY id),'[]') FROM ticket_intake.intakes i),
 'clients',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM ticket_intake.clients c),
 'contacts',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM ticket_intake.client_contacts c),
 'tickets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM ticket_intake.tickets t),
 'pending',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM ticket_intake.pending_interactions p),
 'outbox',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]') FROM ticket_intake.outbox o));`);
const existing=(name,email)=>inspect(`SET ROLE ticket_owner;WITH c AS (INSERT INTO ticket_intake.clients(kind,display_name,name_norm) VALUES('company',${lit(name)},ticket_intake.v1_name(${lit(name)})) RETURNING id),ct AS (
 INSERT INTO ticket_intake.client_contacts(client_id,email_original,email_norm,email_source,email_syntax_validated_at) SELECT id,${lit(email)},ticket_intake.v1_email(${lit(email)}),'import',clock_timestamp() FROM c RETURNING id,client_id)
 SELECT jsonb_build_object('clientId',client_id,'contactId',id) FROM ct;`);
const outClaimSQL=()=>`SELECT ticket_intake.claim_v1_outbox('FAKE_OUTBOX',${bot},${chat});`;
const outClaim=()=>result(outClaimSQL());
const dispatch=o=>result(`SELECT ticket_intake.begin_v1_delivery(${lit(o.outboxId)},${lit(o.leaseToken)});`);
const finish=(o,message,classification=null)=>result(`SELECT ticket_intake.finish_v1_delivery(${lit(o.outboxId)},${lit(o.leaseToken)},${message??'NULL'},${classification?lit(classification):'NULL'},1);`);
const deliveredPrompt=(message=7001)=>{const o=outClaim();assert.equal(o.outcome,'claimed');dispatch(o);assert.equal(finish(o,message).outcome,'sent');return o;};
const test=async(name,fn)=>{reset();await fn();report.tests.push({name,result:'passed'});console.log('PASS '+name);};

const adapt=(source,digest)=>source.replaceAll('ticket_system',db).replaceAll('ticket_backend_read',readRole).replaceAll('ticket_backend_admin',adminRole).replaceAll(":'migration_sha256'",lit(digest));
const asRead=q=>admin('SET SESSION AUTHORIZATION '+readRole+';'+q);
const asAdmin=q=>admin('SET SESSION AUTHORIZATION '+adminRole+';'+q);
const asAdminParallel=q=>parallel('RESET SESSION AUTHORIZATION;SET SESSION AUTHORIZATION '+adminRole+';'+q);
const maintSQL=()=>`SELECT ticket_intake.run_backend_maintenance(${bot},${user},${chat},50);`;
const maint=()=>result(maintSQL());
const health=()=>JSON.parse(asRead(`SELECT ticket_intake.automation_health(${bot},${user},${chat});`));
const adminActionSQL=(id,action,request,version,receipt=null,ack=false)=>`SELECT ticket_intake.admin_reconcile_delivery(${lit(id)},${lit(action)},'FAKE_OPERATOR',${lit(request)},${lit(version)}::timestamptz,${receipt??'NULL'},${ack});`;
const adminAction=(...args)=>JSON.parse(asAdmin(adminActionSQL(...args)));
const rawVoice=()=>{const n=++seq;return result(`SELECT ticket_intake.ingest_message(${bot},${n},${user},${chat},${n},'voice',${json({fileId:'FAKE_RAW_'+n,fileUniqueId:'FAKE_RAW_UNIQUE_'+n,mimeType:'audio/ogg',sizeBytes:20,durationSeconds:1})},${json(policy)});`);};
const phasePolicy={version:'phase2a-1',maxAudioBytes:10000000,maxDurationSeconds:600,leaseSeconds:300,hardTtlHours:72,successGraceHours:1};
const phaseClaimSQL=()=>`SELECT ticket_intake.claim_work('FAKE_PHASE_WORKER',${bot},${user},${chat},${json(phasePolicy)});`;
const phaseClaim=()=>result(phaseClaimSQL());
const phaseArgs=w=>`${lit(w.workId)}::uuid,${lit(w.leaseToken)}::uuid,${lit(w.revision)}::bigint`;
const phaseBegin=w=>result(`SELECT ticket_intake.begin_stage(${phaseArgs(w)});`);
const phaseRenew=w=>result(`SELECT ticket_intake.renew_work(${phaseArgs(w)});`);
const phaseAudio=()=>{const b=Buffer.from('OggSFAKE_HARDENING_'+seq);return {audioBase64:b.toString('base64'),mimeType:'audio/ogg',sizeBytes:b.length,sha256:hash(b)};};
const phaseCheckpoint=(w,p)=>result(`SELECT ticket_intake.checkpoint_stage(${phaseArgs(w)},${json(p)});`);

try {
 docker(['exec',container,'createdb','-U','relay_bootstrap','-O','ticket_owner','-T','template0',db]);created=true;
 docker(args('postgres'),adapt(readFileSync(new URL('../database/test-capabilities.sql',import.meta.url),'utf8'),''));
 report.version=admin('SHOW server_version;');assert.match(report.version,/^18\.6/);
 for(const name of ['001_schema.sql','002_phase1_operations.sql','003_grants.sql','004_phase2a_worker.proposed.sql','005_v1_completion.sql','006_backend_hardening.sql']){
   const bytes=readFileSync(new URL('../database/migrations/'+name,import.meta.url));report.sourceHashes[name]=hash(bytes);
   admin('SET ROLE ticket_owner;\n'+adapt(bytes.toString(),hash(bytes)));
 }
 admin('SET ROLE ticket_owner;\n'+adapt(readFileSync(new URL('../database/migrations/006_backend_hardening.sql',import.meta.url),'utf8'),report.sourceHashes['006_backend_hardening.sql']));
 report.migration='001-006 applied; 006 reapplication clean';
 await test('A existing email client: one ticket, no contact overwrite, one confirmation',()=>{
   const c=existing('FAKE ACME','fake-existing@example.invalid');voice({company:'FAKE NEW NAME',email:'fake-existing@example.invalid'});
   const before=state().contacts;const {w,r}=run();assert.equal(r.outcome,'completed');const s=state();
   assert.equal(s.clients.length,1);assert.equal(s.tickets.length,1);assert.equal(s.tickets[0].client_id,c.clientId);
   assert.deepEqual(s.contacts,before);assert.equal(s.pending.length,0);assert.equal(s.outbox.length,1);
   assert.equal(process(w).outcome,'already_applied');assert.equal(state().tickets.length,1);
 });
 await test('B new email client: exactly one client/contact/ticket/confirmation',()=>{
   voice({clientName:'FAKE PERSON',email:'new-fake@example.invalid'});run();const s=state();
   assert.equal(s.clients.length,1);assert.equal(s.contacts.length,1);assert.equal(s.tickets.length,1);assert.equal(s.outbox.length,1);assert.equal(s.pending.length,0);
 });
 await test('C missing email -> persisted prompt -> valid reply -> same intake completed',()=>{
   const v=voice({company:'FAKE NEW CLIENT'});const {w,r}=run();assert.equal(r.outcome,'waiting');
   assert.equal(process(w).outcome,'already_applied');let s=state();assert.equal(s.pending.length,1);assert.equal(s.tickets.length,0);assert.equal(s.outbox.length,1);
   deliveredPrompt();text('operator-fake@example.invalid',7001);run();s=state();
   assert.equal(s.pending[0].status,'resolved');assert.equal(s.tickets.length,1);assert.equal(s.tickets[0].intake_id,v.intakeId);assert.equal(s.intakes[0].state,'completed');assert.equal(s.outbox.length,2);
 });
 await test('D invalid email stays open; one retry prompt; duplicate work replay harmless',()=>{
   voice();run();deliveredPrompt();const m=text('not an email',7001);const {w,r}=run();assert.equal(r.outcome,'invalid_email');
   assert.equal(process(w).outcome,'already_applied');const s=state();assert.equal(s.pending.length,1);assert.equal(s.pending[0].status,'open');assert.equal(s.contacts.length,0);assert.equal(s.tickets.length,0);assert.equal(s.outbox.length,2);
   assert.equal(result(`SELECT ticket_intake.lookup_message(${bot},NULL,${chat},${m.telegramMessageId});`).intakeId,s.intakes[0].id);
 });
 await test('E duplicate update/reply and checkpoint never duplicate writes',async()=>{
   voice();run();text('duplicate-fake@example.invalid');const w=claim();const a=await Promise.all([parallel(processSQL(w)),parallel(processSQL(w))]);
   assert.deepEqual(a.map(x=>JSON.parse(x).outcome).sort(),['already_applied','completed']);
   const m=inspect(`SELECT jsonb_build_object('update',update_id,'message',message_id,'text',text_content) FROM ticket_intake.processed_messages WHERE kind='text';`);
   assert.equal(result(`SELECT ticket_intake.ingest_message(${bot},${m.update},${user},${chat},${m.message},'text',${json({text:m.text})},${json(policy)});`).outcome,'duplicate_message');
   const s=state();assert.equal(s.clients.length,1);assert.equal(s.contacts.length,1);assert.equal(s.tickets.length,1);assert.equal(s.outbox.length,2);
 });
 await test('F restart before DB processing reclaims with new fence; stale worker denied',()=>{
   voice({email:'restart-fake@example.invalid'});const old=claim();
   admin(`UPDATE ticket_intake.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(old.workId)};`);
   const next=claim();assert.equal(next.workId,old.workId);assert.notEqual(next.leaseToken,old.leaseToken);
   deny(()=>process(old),'P0002');assert.equal(process(next).outcome,'completed');assert.equal(process(next).outcome,'already_applied');assert.equal(state().tickets.length,1);
 });
 await test('concurrent claims: exactly one owner',async()=>{
   voice({email:'race-fake@example.invalid'});const a=await Promise.all(Array.from({length:5},()=>parallel(claimSQL())));
   const claimed=a.map(JSON.parse).filter(x=>x.outcome==='claimed');assert.equal(claimed.length,1);process(claimed[0]);
 });
 await test('concurrent new clients sharing email: one client/contact, separate tickets',async()=>{
   voice({email:'shared-fake@example.invalid'});voice({email:'shared-fake@example.invalid'});const a=claim(),b=claim();
   await Promise.all([parallel(processSQL(a)),parallel(processSQL(b))]);const s=state();assert.equal(s.clients.length,1);assert.equal(s.contacts.length,1);assert.equal(s.tickets.length,2);
 });
 await test('ambiguous identity: operator chooses DB-generated candidate index only',()=>{
   const a=existing('FAKE SAME COMPANY','one-fake@example.invalid');existing('FAKE SAME COMPANY','two-fake@example.invalid');
   voice({company:'FAKE SAME COMPANY'});run();assert.equal(state().tickets.length,0);assert.equal(state().pending[0].kind,'client_selection');deliveredPrompt();
   text('not-a-number',7001);assert.equal(run().r.outcome,'invalid_selection');
   const candidates=state().pending[0].context.candidates;const index=candidates.findIndex(c=>c.id===a.clientId)+1;
   text(String(index),7001);assert.equal(run().r.outcome,'completed');assert.equal(state().tickets[0].client_id,a.clientId);
 });
 await test('multiple open email interactions: bare reply held; explicit reply correlates safely',()=>{
   voice();run();deliveredPrompt(7101);voice();run();deliveredPrompt(7102);
   text('ambiguous-fake@example.invalid');assert.equal(run().r.reason,'ambiguous_reply');assert.equal(state().tickets.length,0);
   text('specific-fake@example.invalid',7102);assert.equal(run().r.outcome,'completed');assert.equal(state().pending.filter(x=>x.status==='open').length,1);
 });
 await test('old queued text, wrong identity and expired pending revision cannot resolve future intake',()=>{
   text('old-fake@example.invalid');const old=claim();voice();const waiting=run();assert.equal(waiting.r.outcome,'waiting');assert.equal(process(old).outcome,'ignored');
   const other=text('wrong-fake@example.invalid',null,{user:user+1,chat:chat+1});assert.equal(claim().outcome,'idle');
   text('new-fake@example.invalid');const w=claim();admin(`UPDATE ticket_intake.intakes SET revision=revision+1;`);deny(()=>process(w),'P0002');assert.equal(state().tickets.length,0);assert.ok(other.messageId);
 });
 await test('critical priority requires explicit operator confirmation; unknown defaults normal',()=>{
   voice({email:'critical-fake@example.invalid',prioritySuggestion:'critical'});run();assert.equal(state().pending[0].kind,'priority_confirmation');assert.equal(state().tickets.length,0);
   deliveredPrompt();text('CONFIRMAR',7001);run();assert.equal(state().tickets[0].priority,'critical');
 });
 await test('email syntax rejects dangerous/malformed variants',()=>{
   for(const bad of ['bad','a..b@example.invalid','.a@example.invalid','a@-host.invalid','a@host-.invalid','a@host..invalid','a@localhost','a b@example.invalid','a@example.invalid trailing'])
     assert.equal(admin(`SET ROLE ticket_owner;SELECT ticket_intake.v1_email(${lit(bad)}) IS NULL;`),'t');
   assert.equal(admin("SET ROLE ticket_owner;SELECT ticket_intake.v1_email('  Fake+tag@Example.invalid  ');"),'fake+tag@example.invalid');
 });
 await test('forced rollback leaves no client/ticket/outbox/interaction partial writes',()=>{
   voice({email:'rollback-fake@example.invalid'});const w=claim();const before=state();
   runtime(`BEGIN;${processSQL(w)} ROLLBACK;`);assert.deepEqual(state(),before);process(w);assert.equal(state().tickets.length,1);
 });
 await test('outbox fencing, dispatch once, idempotent receipt, sent never claimed again',async()=>{
   voice({email:'outbox-fake@example.invalid'});run();const results=await Promise.all(Array.from({length:4},()=>parallel(outClaimSQL())));
   const o=results.map(JSON.parse).find(x=>x.outcome==='claimed');assert.equal(results.map(JSON.parse).filter(x=>x.outcome==='claimed').length,1);
   const d=dispatch(o);assert.equal(d.outcome,'dispatch');deny(()=>dispatch(o),'P0002');
   assert.equal(finish(o,7201).outcome,'sent');assert.equal(finish(o,7201).outcome,'already_applied');assert.equal(outClaim().outcome,'idle');
 });
 await test('outbox restart after dispatch becomes uncertain, never blindly resent',()=>{
   voice({email:'uncertain-fake@example.invalid'});run();const o=outClaim();dispatch(o);
   admin(`UPDATE ticket_intake.outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(o.outboxId)};`);
   assert.equal(outClaim().outcome,'needs_operator');assert.equal(state().outbox[0].status,'uncertain');assert.equal(outClaim().outcome,'idle');deny(()=>finish(o,7301),'P0002');
 });
 await test('outbox restart before dispatch safely reclaims; 429 safely retries',()=>{
   voice({email:'rate-fake@example.invalid'});run();const old=outClaim();
   admin(`UPDATE ticket_intake.outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(old.outboxId)};`);
   const o=outClaim();assert.notEqual(o.leaseToken,old.leaseToken);deny(()=>dispatch(old),'P0002');dispatch(o);assert.equal(finish(o,null,'rate_limited').outcome,'queued');
   admin('UPDATE ticket_intake.outbox SET available_at=clock_timestamp();');const next=outClaim();dispatch(next);finish(next,7401);assert.equal(state().outbox[0].status,'sent');
 });
 await test('runtime least privilege: entrypoints only; direct tables/sequences/helpers/escalation denied',()=>{
   deny(()=>runtime('SELECT * FROM ticket_intake.clients;'),'42501');deny(()=>runtime("INSERT INTO ticket_intake.clients(kind,display_name,name_norm) VALUES('individual','FAKE','fake');"),'42501');
   deny(()=>runtime("SELECT nextval('ticket_intake.tickets_ticket_number_seq');"),'42501');
   deny(()=>runtime("SELECT ticket_intake.v1_email('fake@example.invalid');"),'42501');deny(()=>runtime('SELECT ticket_intake.v1_finalize(gen_random_uuid());'),'42501');
   deny(()=>runtime('SET ROLE ticket_owner;'),'42501');deny(()=>runtime('ALTER ROLE ticket_n8n SUPERUSER;'),'42501');
   assert.equal(runtime("SELECT count(*) FROM pg_tables WHERE schemaname='ticket_intake' AND has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT,INSERT,UPDATE,DELETE');"),'0');
 });
// Inserted into the isolated test harness by build-hardening-tests.mjs.
 await test('retention eligible/ineligible, revision-safe prompt, transcript/extraction intact, repeat safe',()=>{
   const a=voice();run();const b=voice();run();
   admin(`UPDATE ticket_intake.intakes SET audio_purge_after=clock_timestamp()-interval '1 second' WHERE id=${lit(a.intakeId)};`);
   const before=state(),r=maint();assert.equal(r.purgedAudio,1);assert.equal(r.expiredInteractions,0);
   assert.equal(admin(`SELECT audio_bytes IS NULL FROM ticket_intake.intakes WHERE id=${lit(a.intakeId)};`),'t');
   assert.equal(admin(`SELECT audio_bytes IS NOT NULL FROM ticket_intake.intakes WHERE id=${lit(b.intakeId)};`),'t');
   const after=state();for(const x of before.intakes){const y=after.intakes.find(i=>i.id===x.id);assert.equal(y.transcript_original,x.transcript_original);assert.deepEqual(y.extraction,x.extraction);assert.equal(y.revision,x.revision);}
   assert.equal(maint().purgedAudio,0);assert.equal(state().tickets.length,0);
 });
 await test('retention hard cap, no transcript terminal handling, live lease protection and scope',()=>{
   const a=rawVoice();admin(`UPDATE ticket_intake.intakes SET audio_bytes=convert_to('OggSFAKE','UTF8'),audio_size_bytes=8,audio_sha256=encode(sha256(convert_to('OggSFAKE','UTF8')),'hex'),audio_mime_type='audio/ogg',audio_stored_at=clock_timestamp()-interval '73 hours',audio_purge_after=clock_timestamp()+interval '10 days' WHERE id=${lit(a.intakeId)};`);
   const w=phaseClaim();assert.equal(maint().purgedAudio,0);admin(`UPDATE ticket_intake.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(w.workId)};`);
   assert.equal(maint().purgedAudio,1);assert.equal(state().intakes[0].state,'needs_operator');assert.equal(admin(`SELECT status FROM ticket_intake.work_items WHERE id=${lit(w.workId)};`),'needs_operator');
   voice();admin("UPDATE ticket_intake.intakes SET audio_purge_after=clock_timestamp()-interval '1 second' WHERE transcript_original IS NOT NULL;");
   assert.equal(result(`SELECT ticket_intake.run_backend_maintenance(${bot},${user+1},${chat+1},50);`).purgedAudio,0);
 });
 await test('retention forced rollback/restart retries without loss or duplicate metadata',()=>{
   voice();admin("UPDATE ticket_intake.intakes SET audio_purge_after=clock_timestamp()-interval '1 second';");
   const snapshot=state();runtime(`BEGIN;${maintSQL()}ROLLBACK;`);assert.deepEqual(state(),snapshot);
   assert.equal(maint().purgedAudio,1);assert.equal(maint().purgedAudio,0);
 });
 await test('pending default configurable; expiry idempotent; late explicit reply cannot mutate intake',()=>{
   admin('UPDATE ticket_intake.backend_policy SET interaction_ttl_hours=1;');voice();run();
   assert.equal(admin("SELECT abs(extract(epoch FROM expires_at-created_at)-3600)<5 FROM ticket_intake.pending_interactions;"),'t');
   deliveredPrompt();admin("UPDATE ticket_intake.pending_interactions SET expires_at=clock_timestamp()-interval '1 second';");
   text('late-fake@example.invalid',7001);assert.equal(run().r.outcome,'ignored');assert.equal(state().tickets.length,0);
   assert.equal(maint().expiredInteractions,1);assert.equal(state().pending[0].status,'expired');assert.equal(state().intakes[0].state,'needs_operator');assert.equal(maint().expiredInteractions,0);
 });
 await test('valid explicit reply survives simultaneous eligible purge',async()=>{
   voice();run();deliveredPrompt();admin("UPDATE ticket_intake.intakes SET audio_purge_after=clock_timestamp()-interval '1 second';");text('race-purge-fake@example.invalid',7001);const w=claim();
   await Promise.all([parallel(processSQL(w)),parallel(maintSQL())]);assert.equal(state().tickets.length,1);assert.equal(state().pending[0].status,'resolved');maint();
   assert.equal(admin('SELECT audio_bytes IS NULL FROM ticket_intake.intakes;'),'t');
 });
 await test('A ten duplicate Telegram updates concurrently: one message/intake/work',async()=>{
   const n=++seq,msg={fileId:'FAKE_TORTURE_FILE',fileUniqueId:'FAKE_TORTURE_UNIQUE',mimeType:'audio/ogg',sizeBytes:10,durationSeconds:1};
   const q=`SELECT ticket_intake.ingest_message(${bot},${n},${user},${chat},${n},'voice',${json(msg)},${json(policy)});`;
   const results=await Promise.all(Array.from({length:10},()=>parallel(q)));assert.equal(results.map(JSON.parse).filter(x=>x.outcome==='accepted').length,1);
   assert.equal(admin('SELECT count(*) FROM ticket_intake.processed_messages;'),'1');assert.equal(state().intakes.length,1);
 });
 await test('B ten Phase-2 workers race: one owner',async()=>{
   rawVoice();const rows=await Promise.all(Array.from({length:10},()=>parallel(phaseClaimSQL())));assert.equal(rows.map(JSON.parse).filter(x=>x.outcome==='claimed').length,1);
 });
 await test('C two valid replies racing one interaction: one applies, other ignored',async()=>{
   voice();run();deliveredPrompt();text('first-fake@example.invalid',7001);text('second-fake@example.invalid',7001);const a=claim(),b=claim();
   const r=await Promise.all([parallel(processSQL(a)),parallel(processSQL(b))]);assert.deepEqual(r.map(JSON.parse).map(x=>x.outcome).sort(),['completed','ignored']);
   assert.equal(state().tickets.length,1);assert.equal(state().contacts.length,1);assert.equal(state().pending[0].status,'resolved');
 });
 await test('E actual PostgreSQL connection termination after possible-send marker: uncertain, no resend',async()=>{
   voice({email:'disconnect-fake@example.invalid'});run();const o=outClaim();dispatch(o);
   const pending=parallel(`SET application_name='FAKE_AFTER_SEND';BEGIN;SELECT ticket_intake.finish_v1_delivery(${lit(o.outboxId)},${lit(o.leaseToken)},7501,NULL,30);SELECT pg_sleep(10);COMMIT;`).then(()=>false,()=>true);
   await new Promise(r=>setTimeout(r,700));assert.equal(admin(`SELECT count(*) FROM pg_stat_activity WHERE datname=${lit(db)} AND application_name='FAKE_AFTER_SEND';`),'1');
   admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${lit(db)} AND application_name='FAKE_AFTER_SEND';`);assert.equal(await pending,true);
   admin(`UPDATE ticket_intake.outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(o.outboxId)};`);
   assert.equal(outClaim().outcome,'needs_operator');assert.equal(state().outbox[0].status,'uncertain');assert.equal(outClaim().outcome,'idle');
 });
 await test('G/H Groq 429/500/timeout: bounded retry preserves download checkpoint',()=>{
   rawVoice();const d=phaseBegin(phaseClaim());phaseRenew(d);phaseCheckpoint(d,phaseAudio());
   const before=admin('SELECT audio_sha256 FROM ticket_intake.intakes;');
   for(let attempt=1;attempt<=5;attempt++){
     const w=phaseBegin(phaseClaim());phaseRenew(w);const evidence=attempt===1?{statusCode:429}:attempt===2?{statusCode:500}:{error:{code:'ETIMEDOUT'}};
     const cls=classifyStageFailure(evidence);assert.equal(cls,'transient_external');
     const r=result(`SELECT ticket_intake.fail_work(${phaseArgs(w)},${lit(cls)},1);`);assert.equal(r.outcome,attempt<5?'retry_scheduled':'needs_operator');
     assert.equal(admin('SELECT audio_sha256 FROM ticket_intake.intakes;'),before);
     if(attempt<5)admin("UPDATE ticket_intake.work_items SET available_at=clock_timestamp() WHERE status='queued';");
   }
   assert.equal(state().intakes[0].state,'needs_operator');assert.equal(state().tickets.length,0);
 });
 await test('I restart after begin: download refenced; paid-call ambiguity held, no repeat',()=>{
   rawVoice();const old=phaseBegin(phaseClaim());admin(`UPDATE ticket_intake.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(old.workId)};`);
   const current=phaseBegin(phaseClaim());assert.notEqual(current.leaseToken,old.leaseToken);deny(()=>phaseRenew(old),'P0002');phaseRenew(current);phaseCheckpoint(current,phaseAudio());
   const t=phaseBegin(phaseClaim());phaseRenew(t);admin(`UPDATE ticket_intake.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${lit(t.workId)};`);
   assert.equal(phaseClaim().outcome,'needs_operator');assert.equal(state().intakes[0].last_error_code,'provider_unknown_result');
 });
 await test('L malformed/large sanitized ingress rejects without corruption',()=>{
   const n=++seq;
   for(const payload of [{text:'x'.repeat(8001)},{text:'FAKE',url:'http://127.0.0.1/private'},{fileId:'FAKE',fileUniqueId:''}]){
     const kind=payload.text?'text':'voice';deny(()=>result(`SELECT ticket_intake.ingest_message(${bot},${n},${user},${chat},${n},${lit(kind)},${json(payload)},${json(policy)});`),'22023');
   }
   assert.equal(state().intakes.length,0);assert.equal(admin('SELECT count(*) FROM ticket_intake.processed_messages;'),'0');
 });
 await test('admin mark_delivered/cancel: audited, immutable receipt, idempotent request',()=>{
   for(const action of ['mark_delivered','cancel']){
     voice({email:action+'-fake@example.invalid'});run();const o=outClaim();dispatch(o);finish(o,null,'delivery_unknown');
     const before=inspect(`SELECT to_jsonb(o) FROM ticket_intake.outbox o WHERE id=${lit(o.outboxId)};`),request=randomUUID();
     const r=adminAction(o.outboxId,action,request,before.updated_at,action==='mark_delivered'?7601:null);assert.equal(r.state,action==='cancel'?'cancelled':'delivered_admin');
     assert.equal(adminAction(o.outboxId,action,request,before.updated_at,action==='mark_delivered'?7601:null).replayed,true);
     const after=inspect(`SELECT to_jsonb(o) FROM ticket_intake.outbox o WHERE id=${lit(o.outboxId)};`);assert.equal(after.telegram_message_id,before.telegram_message_id);assert.equal(after.dispatch_started_at,before.dispatch_started_at);
   }
   assert.equal(admin('SELECT count(*) FROM ticket_intake.delivery_admin_actions;'),'2');assert.equal(outClaim().outcome,'idle');
 });
 await test('admin retry_once: one new attempt, immutable parent; concurrent requests fenced',async()=>{
   voice({email:'adminretry-fake@example.invalid'});run();const o=outClaim();dispatch(o);finish(o,null,'delivery_unknown');
   const before=inspect(`SELECT to_jsonb(o) FROM ticket_intake.outbox o WHERE id=${lit(o.outboxId)};`),request=randomUUID();
   deny(()=>adminAction(o.outboxId,'retry_once',request,before.updated_at,null,false),'22023');
   const q=adminActionSQL(o.outboxId,'retry_once',request,before.updated_at,null,true);
   const r=await Promise.all([asAdminParallel(q),asAdminParallel(q)]);assert.equal(r.map(JSON.parse).filter(x=>x.replayed===true).length,1);
   const s=state();assert.equal(s.outbox.length,2);const child=s.outbox.find(x=>x.parent_outbox_id===o.outboxId);assert.equal(child.max_attempts,1);assert.equal(child.status,'queued');
   assert.equal(s.outbox.find(x=>x.id===o.outboxId).telegram_message_id,before.telegram_message_id);deny(()=>adminAction(o.outboxId,'cancel',randomUUID(),before.updated_at),'P0002');
   const next=outClaim();dispatch(next);finish(next,null,'rate_limited');assert.equal(state().outbox.find(x=>x.id===child.id).status,'needs_operator');assert.equal(outClaim().outcome,'idle');
 });
 await test('admin retry of expired prompt forbidden; n8n/read role cannot act or escalate',()=>{
   voice();run();const o=outClaim();dispatch(o);finish(o,null,'delivery_unknown');admin("UPDATE ticket_intake.pending_interactions SET expires_at=clock_timestamp()-interval '1 second';");
   const version=inspect(`SELECT to_jsonb(o) FROM ticket_intake.outbox o WHERE id=${lit(o.outboxId)};`).updated_at;
   deny(()=>adminAction(o.outboxId,'retry_once',randomUUID(),version,null,true),'22023');
   deny(()=>runtime(adminActionSQL(o.outboxId,'cancel',randomUUID(),version)),'42501');
   deny(()=>asRead(adminActionSQL(o.outboxId,'cancel',randomUUID(),version)),'42501');
   deny(()=>runtime(`SET ROLE ${adminRole};`),'42501');deny(()=>runtime('SELECT * FROM ticket_intake.delivery_admin_actions;'),'42501');
 });
 await test('health response scoped, payload-safe; counters reflect failures/expiry/receipts',()=>{
   voice();run();const h=health();assert.equal(h.schemaVersion,'automation-health-1');assert.equal(h.interactions.open,1);assert.equal(h.outbox.queued,1);
   assert.doesNotMatch(JSON.stringify(h),/transcript_original|audio_bytes|audioBase64|lease_token|leaseToken|provider output|FAKE TEST|example\.invalid/);
   const other=JSON.parse(asRead(`SELECT ticket_intake.automation_health(${bot},${user+1},${chat+1});`));assert.equal(other.interactions.open,0);assert.equal(other.intakes.awaitingOperator,0);
   deny(()=>runtime(`SELECT ticket_intake.automation_health(${bot},${user},${chat});`),'42501');
 });
 await test('migration ledger checksums/roles and active contact uniqueness; shared email still allowed',()=>{
   assert.equal(admin('SELECT count(*) FROM ticket_intake.migration_history;'),'6');
   assert.equal(admin("SELECT sha256 FROM ticket_intake.migration_history WHERE version=6;"),report.sourceHashes['006_backend_hardening.sql']);
   const a=existing('FAKE CLIENT A','ledger-fake@example.invalid');existing('FAKE CLIENT B','ledger-fake@example.invalid');
   deny(()=>admin(`INSERT INTO ticket_intake.client_contacts(client_id,email_original,email_norm,email_source,email_syntax_validated_at) VALUES(${lit(a.clientId)},'ledger-fake@example.invalid','ledger-fake@example.invalid','import',clock_timestamp());`),'23505');
 });

 report.result='passed';
} catch(e) {report.result='failed';report.error='Synthetic database test failed';throw new Error(report.error);}
finally {
 if(created){docker(['exec',container,'dropdb','-U','relay_bootstrap',db]);docker(args('postgres'),'DROP ROLE IF EXISTS '+readRole+';DROP ROLE IF EXISTS '+adminRole+';');}
 report.rolesUnchanged=rolesBefore===roleFingerprint();
 report.disposableRemoved=docker(args('postgres'),`SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=${lit(db)});`).trim()==='t';
 report.baselineAfter=baselineFingerprint();report.baselineUnchanged=report.baselineBefore===report.baselineAfter;
 writeFileSync(new URL('../audit-local/hardening-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({result:report.result,tests:report.tests.length,removed:report.disposableRemoved,baselineUnchanged:report.baselineUnchanged,sha256:report.sourceHashes['006_backend_hardening.sql']}));
}
assert.ok(report.disposableRemoved);assert.ok(report.baselineUnchanged);

assert.ok(report.rolesUnchanged);
