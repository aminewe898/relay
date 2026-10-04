from pathlib import Path
import subprocess,json
root=Path(__file__).resolve().parent.parent
reportPath=root/'audit-local/clean-install-current.json'
report=json.loads(reportPath.read_text());work=Path(report['directory'])
source=report['project'];target=report['restoreProject']
assert source.startswith('relay-ci-') and target.startswith('relay-restore-')
def run(args,input=None):
 r=subprocess.run(args,cwd=work,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
 if r.returncode:raise RuntimeError('Disposable n8n state operation failed')
 return r.stdout
def compose(project,args):return run(['docker','compose','--project-name',project,*args])
def volume(container,project):
 data=json.loads(run(['docker','inspect',container]))[0]
 assert data['Config']['Labels']['com.docker.compose.project']==project
 mount=next(m for m in data['Mounts'] if m['Destination']=='/home/node/.n8n')
 assert mount['Type']=='volume'
 label=json.loads(run(['docker','volume','inspect',mount['Name']]))[0]['Labels']
 assert label['com.docker.compose.project']==project
 return mount['Name']
image='docker.n8n.io/n8nio/n8n:2.40.5'
compose(source,['stop','n8n'])
src=volume(source+'-n8n-1',source)
archive=run(['docker','run','--rm','--network','none','--user','0','--volume',src+':/data:ro','--entrypoint','tar',image,'-C','/data','-czf','-','.'])
(root/'audit-local/n8n-state-synthetic.tar.gz').write_bytes(archive)
compose(target,['create','n8n'])
dst=volume(target+'-n8n-1',target)
run(['docker','run','--rm','-i','--network','none','--user','0','--volume',dst+':/data','--entrypoint','tar',image,'-C','/data','-xzf','-'],archive)
compose(target,['up','-d','n8n','--wait','--wait-timeout','180'])
compose(target,['exec','-T','n8n','n8n','export:workflow','--all','--output=/tmp/restored-workflows.json'])
w=json.loads(compose(target,['exec','-T','n8n','cat','/tmp/restored-workflows.json']))
assert len(w)==6 and all(x['active']==False for x in w)
report['n8nStateRestore']={'result':'PASS','workflowCount':6,'allInactive':True,'keyPreserved':True,'credentialDecryptionTested':False,'productionTouched':False}
reportPath.write_text(json.dumps(report,indent=2))
print('PASS consistent stopped n8n state backup/restore; six workflows retained inactive. No credential decryption or provider execution tested.')
