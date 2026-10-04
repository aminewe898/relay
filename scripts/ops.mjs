import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const command=process.argv[2];
const envPath=resolve(root,'.env');
function fail(message){console.error(message);process.exit(1);}
if(!existsSync(envPath))fail('Copy .env.example to .env and configure it first.');
process.loadEnvFile(envPath);
const project=process.env.COMPOSE_PROJECT_NAME;
if(!project||!/^relay(?:-[a-z0-9-]+)?$/.test(project))fail('Use an explicit isolated COMPOSE_PROJECT_NAME starting with relay.');
const db=process.env.POSTGRES_DB;
if(db!=='ticket_system')fail('Immutable migrations require POSTGRES_DB=ticket_system.');
const user=process.env.POSTGRES_USER;
if(!user||!/^[a-z][a-z0-9_]{0,62}$/.test(user)||['ticket_n8n','ticket_owner','relay_reader'].includes(user))fail('Configure a distinct valid bootstrap user.');
function docker(args,input,encoding='utf8'){
 const result=spawnSync('docker',args,{cwd:root,env:process.env,input,encoding,windowsHide:true,maxBuffer:256*1024*1024});
 if(result.error||result.status!==0)fail('Docker operation failed. Inspect local service status; raw output is withheld to protect secrets.');
 return result.stdout;
}
const compose=(args,input,encoding)=>docker(['compose','--project-name',project,'--file',resolve(root,'docker-compose.yml'),...args],input,encoding);
const sql=(query)=>compose(['exec','-T','postgres','psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U',user,'-d',db],query).trim();
function checkEnv(){
 for(const key of ['POSTGRES_PASSWORD','TICKET_RUNTIME_PASSWORD','RELAY_READER_PASSWORD','N8N_ENCRYPTION_KEY','SERVICE_DESK_AUTH_PASSWORD'])
  if(!process.env[key]||process.env[key].length<32)fail(`Configure ${key} with at least 32 characters.`);
 if(new Set(['POSTGRES_PASSWORD','TICKET_RUNTIME_PASSWORD','RELAY_READER_PASSWORD'].map(k=>process.env[k])).size!==3)fail('Use distinct database passwords.');
 if(!process.env.SERVICE_DESK_AUTH_USER||!process.env.SERVICE_DESK_DATABASE_URL)fail('Configure console authentication and reader connection URL.');
 let uri;try{uri=new URL(process.env.SERVICE_DESK_DATABASE_URL);}catch{fail('Invalid reader connection URL.');}
 if(uri.hostname!=='postgres'||decodeURIComponent(uri.username)!=='relay_reader'||uri.pathname!=='/ticket_system'||decodeURIComponent(uri.password)!==process.env.RELAY_READER_PASSWORD)fail('Reader URL must reference relay_reader on postgres/ticket_system with the matching reader password.');
 for(const[k,min,max]of [['AUDIO_RETENTION_HOURS',1,72],['INTERACTION_EXPIRY_HOURS',1,720]])
  if(!/^\d+$/.test(process.env[k]||'')||Number(process.env[k])<min||Number(process.env[k])>max)fail(`Invalid ${k}.`);
}
function migrations(){
 const hashes=JSON.parse(readFileSync(resolve(root,'database/migrations/checksums.json'),'utf8'));
 for(const[file,hash]of Object.entries(hashes))if(createHash('sha256').update(readFileSync(resolve(root,'database/migrations',file))).digest('hex')!==hash)fail('Migration checksum mismatch. Never rewrite applied migrations.');
 const rows=JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('filename',filename,'sha256',sha256) ORDER BY version),'[]') FROM ticket_intake.migration_history;"));
 if(rows.length!==6||rows.some(r=>hashes[r.filename]!==r.sha256))fail('Database migration history does not match packaged migrations.');
 if(sql("SELECT count(DISTINCT p.proname) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='ticket_intake' AND p.proname IN ('ingest_message','run_backend_maintenance','claim_work');")!=='3')fail('Required functions missing.');
 if(sql(`SELECT (audio_hard_ttl_hours BETWEEN 1 AND 72 AND interaction_ttl_hours BETWEEN 1 AND 720)::text FROM ticket_intake.backend_policy WHERE singleton;`)!=='true')fail('Invalid retention policy.');
 console.log('PASS migration checksums, schema functions and retention policy.');
}
async function verify(){
 migrations();
 const n8n=await fetch(`http://127.0.0.1:${process.env.N8N_PORT||5678}/healthz`,{signal:AbortSignal.timeout(5000)});
 if(!n8n.ok)fail('n8n health check failed.');
 const headers={authorization:'Basic '+Buffer.from(`${process.env.SERVICE_DESK_AUTH_USER}:${process.env.SERVICE_DESK_AUTH_PASSWORD}`).toString('base64')};
 const res=await fetch(`http://127.0.0.1:${process.env.APP_PORT||3100}/api/v1/snapshot`,{headers,signal:AbortSignal.timeout(10000)});
 if(!res.ok||(await res.json()).source!=='live')fail('Console cannot read its database projections.');
 console.log('PASS n8n health and authenticated frontend database read. No external provider requests.');
}
try{
 checkEnv();
 if(command==='setup'){
  docker(['version','--format','{{.Server.Version}}']);
  compose(['config','--quiet']);
  compose(['up','-d','--build','--wait','--wait-timeout','240']);
  await verify();
  console.log('Next: create n8n credentials, import/rebind inactive workflows, configure TI-00. See docs/n8n-setup.md.');
 }else if(command==='migrate'){
  // Bootstrap runs only on a new named volume. This command never reapplies one-shot SQL.
  compose(['up','-d','postgres','--wait','--wait-timeout','180']);migrations();
 }else if(command==='verify-installation')await verify();
 else if(command==='backup'){
  mkdirSync(resolve(root,'backups'),{recursive:true});
  const path=resolve(root,'backups',`relay-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
  const data=compose(['exec','-T','postgres','pg_dump','-U',user,'-d',db,'-Fc'],undefined,null);
  writeFileSync(path,data,{mode:0o600,flag:'wx'});
  console.log('Application backup written under ignored backups/. Store encrypted copies and separately back up n8n/key.');
 }else if(command==='restore'){
  if(!project.startsWith('relay-restore-')||!process.argv.includes('--confirm-disposable'))fail('Restore requires a new relay-restore-* project and --confirm-disposable. Never restore into production.');
  const path=process.argv[3];if(!path||path.startsWith('--'))fail('Provide a backup path.');
  if(sql('SELECT (SELECT count(*) FROM ticket_intake.clients)+(SELECT count(*) FROM ticket_intake.intakes)+(SELECT count(*) FROM ticket_intake.processed_messages)+(SELECT count(*) FROM ticket_intake.work_items)+(SELECT count(*) FROM ticket_intake.outbox);')!=='0')fail('Restore destination must contain no application data.');
  // Explicitly authorized disposable destination only. Replaces its schema, never roles/credentials.
  compose(['exec','-T','postgres','pg_restore','-U',user,'-d',db,'--clean','--if-exists','--exit-on-error'],readFileSync(resolve(path)),null);
  migrations();console.log('Restore verified. Workers remain inactive; manually verify console and n8n setup.');
 }else fail('Unknown operation.');
}catch{fail('Operation failed; no secret or database payload was printed.');}
