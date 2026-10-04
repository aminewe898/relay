from pathlib import Path
import json,shutil,secrets,uuid,subprocess,os,time
root=Path(__file__).resolve().parent.parent
source=root
project='relay-ci-'+uuid.uuid4().hex[:12]
work=root/'audit-local'/project
shutil.copytree(source,work,ignore=shutil.ignore_patterns('node_modules','.next','dist','.env','backups','audit-local','.git','__pycache__','*.pyc','*.tsbuildinfo'))
for args in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Relay Release Test','-c','user.email=release-test@example.invalid','commit','-q','-m','Disposable sanitized release snapshot'],['git','checkout-index','--all','--force']]:
 r=subprocess.run(args,cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if r.returncode:raise RuntimeError('Disposable Git snapshot failed')
env=(work/'.env.example').read_text()
values={k:secrets.token_hex(24) for k in ['POSTGRES_PASSWORD','TICKET_RUNTIME_PASSWORD','RELAY_READER_PASSWORD','SERVICE_DESK_AUTH_PASSWORD','N8N_ENCRYPTION_KEY']}
values.update(COMPOSE_PROJECT_NAME=project,SERVICE_DESK_AUTH_USER='synthetic-reader',SERVICE_DESK_DATABASE_URL='postgresql://relay_reader:'+values['RELAY_READER_PASSWORD']+'@postgres:5432/ticket_system',APP_PORT='33100',N8N_PORT='35678')
for key,value in values.items():
 env='\n'.join(key+'='+value if line.startswith(key+'=') else line for line in env.split('\n'))
(work/'.env').write_text(env,encoding='utf-8')
metadata={'project':project,'directory':str(work),'tests':[],'productionAccess':False,'providerRequests':False,'cleanGitSnapshot':True,'originalHistoryAvailable':False}
(root/'audit-local/clean-install-current.json').write_text(json.dumps(metadata,indent=2))
def run(name,args,timeout=600,input=None):
 print('START '+name,flush=True)
 r=subprocess.run(args,cwd=work,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 (root/'audit-local'/(name+'.log')).write_bytes(r.stdout+r.stderr)
 metadata['tests'].append({'name':name,'exitCode':r.returncode})
 (root/'audit-local/clean-install-current.json').write_text(json.dumps(metadata,indent=2))
 print(('PASS ' if r.returncode==0 else 'FAIL ')+name,flush=True)
 if r.returncode:raise RuntimeError(name)
 return r.stdout
dc=['docker','compose','--project-name',project]
try:
 npm='npm.cmd' if os.name=='nt' else 'npm'
 run('clean-root-npm-ci',[npm,'ci'])
 run('clean-root-check',[npm,'run','check'])
 frontendRun=subprocess.run([npm,'ci'],cwd=work/'frontend',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600)
 (root/'audit-local/clean-frontend-ci.log').write_bytes(frontendRun.stdout+frontendRun.stderr)
 if frontendRun.returncode:raise RuntimeError('clean-frontend-ci')
 frontendRun=subprocess.run([npm,'run','check'],cwd=work/'frontend',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600)
 (root/'audit-local/clean-frontend-check.log').write_bytes(frontendRun.stdout+frontendRun.stderr)
 metadata['tests'].append({'name':'clean-frontend-check','exitCode':frontendRun.returncode})
 if frontendRun.returncode:raise RuntimeError('clean-frontend-check')
 print('PASS clean frontend check',flush=True)
 run('compose-config',dc+['config','--quiet'])
 run('compose-build',dc+['build'],1200)
 run('compose-up',dc+['up','-d','--wait','--wait-timeout','240'],600)
 run('installation-verify',['node','scripts/ops.mjs','verify-installation'])
 run('setup-rerun',['node','scripts/ops.mjs','setup'],600)
 run('workflow-import',dc+['exec','-T','n8n','n8n','import:workflow','--separate','--input=/opt/relay/workflows'])
 run('workflow-export',dc+['exec','-T','n8n','n8n','export:workflow','--all','--output=/tmp/relay-workflows.json'])
 raw=run('workflow-export-read',dc+['exec','-T','n8n','cat','/tmp/relay-workflows.json'])
 workflows=json.loads(raw)
 assert len(workflows)==6 and all(w['active']==False for w in workflows)
 metadata['workflowImport']={'count':6,'allInactive':True,'credentialsBound':False,'externalExecution':False}
 (work/'audit-local').mkdir(exist_ok=True)
 os.environ['RELAY_TEST_CONTAINER']=project+'-postgres-1'
 run('database-hardening',['node','test/database-isolated.mjs'])
 run('synthetic-backup-fixture',dc+['exec','-T','postgres','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','relay_bootstrap','-d','ticket_system'],input=b"INSERT INTO ticket_intake.clients(kind,display_name,name_norm) VALUES('company','Acme Demo SL','acme demo sl');")
 run('backup',['node','scripts/ops.mjs','backup'])
 # Rehearsal creates a second explicitly disposable fresh target with its own volume and bootstrap secrets.
 restoreProject='relay-restore-'+uuid.uuid4().hex[:12]
 restoreEnv=env.replace(project,restoreProject)
 (work/'.env').write_text(restoreEnv)
 rd=['docker','compose','--project-name',restoreProject]
 run('restore-bootstrap',['node','scripts/ops.mjs','migrate'])
 dump=next((work/'backups').glob('*.dump'))
 run('restore',['node','scripts/ops.mjs','restore',str(dump),'--confirm-disposable'])
 restored=run('restore-record-verification',rd+['exec','-T','postgres','psql','-X','-q','-At','-U','relay_bootstrap','-d','ticket_system','-c',"SELECT count(*) FROM ticket_intake.clients WHERE display_name='Acme Demo SL';"])
 assert restored.strip()==b'1'
 metadata['restoreProject']=restoreProject
 metadata['result']='PASS'
except Exception as e:
 metadata['result']='FAIL';metadata['failure']=str(e)[:100]
finally:
 (root/'audit-local/clean-install-current.json').write_text(json.dumps(metadata,indent=2))
 print(json.dumps({'result':metadata.get('result'),'project':project,'failure':metadata.get('failure')}),flush=True)
raise SystemExit(0 if metadata.get('result')=='PASS' else 1)
