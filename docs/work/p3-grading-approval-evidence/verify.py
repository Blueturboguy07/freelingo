import os,json,subprocess,hashlib
from pathlib import Path
root=Path('/Users/mannbellani/freelingo-wt/p6-media'); py='/Users/mannbellani/freelingo-wt/p7-kits/tools/coursekit/.venv/bin/python'; ruff=str(Path(py).with_name('ruff'))
env={**os.environ,'PYTHONPATH':'/Users/mannbellani/freelingo-wt/p2r5-upstream/tools/coursekit/src'}
base=['-P','-m','pytest','-p','no:cacheprovider','tools/coursekit/tests/test_grading_approvals_adapter.py','-q']
r=subprocess.run([py,*base,'--junitxml=/private/tmp/p3-grading-approval-verified.xml'],cwd=root,env=env);assert r.returncode==0
for args in [['check','--no-cache'],['format','--check']]:
 r=subprocess.run([ruff,*args,'tools/coursekit/src/coursekit_grading_approvals.py','tools/coursekit/tests/test_grading_approvals_adapter.py'],cwd=root);assert r.returncode==0
source=(root/'tools/coursekit/src/coursekit_grading_approvals.py').read_text();out=Path('/private/tmp/p3-grading-approval-mutants');out.mkdir(exist_ok=True)
changes=[('current-stage','position > cursor and entry["status"] == "ok"','True','old_projection and g4_failed'),('whole-grid','set(slots) == set(expected_selected_slots(units))','True','old_projection and partial_grid'),('answer-set','return expected == approval','return True','old_projection and extra_english'),('contextual-exclusion','"english": [gloss.citation_gloss]','"english": [gloss.citation_gloss, *gloss.valid_alternates]','contextual_decoy'),('validation-drift','_fingerprint(self.lang, kinds, content_paths=(GLOSSARY_RELATIVE_PATH,)) == files','True','change_during')]
results=[]
for name,old,new,selection in changes:
 assert source.count(old)==1,(name,source.count(old))
 m=out/(name+'.py');m.write_text(source.replace(old,new,1))
 with (out/(name+'.log')).open('w') as log:r=subprocess.run([py,*base,'-k',selection,'--junitxml='+str(out/(name+'.xml'))],cwd=root,env={**env,'COURSEKIT_GRADING_APPROVAL_MODULE':str(m)},stdout=log,stderr=subprocess.STDOUT)
 results.append({'name':name,'selection':selection,'exitCode':r.returncode,'moduleSha256':hashlib.sha256(m.read_bytes()).hexdigest()});assert r.returncode==1,(name,r.returncode)
(out/'manifest.json').write_text(json.dumps({'productionSha256':hashlib.sha256(source.encode()).hexdigest(),'mutants':results},indent=2)+'\n')
print('Five isolated guard mutants killed')
r=subprocess.run([py,'-P','/private/tmp/p3-grading-approval-live.py'],env={**env,'COURSEKIT_BUILD_ROOT':'/private/tmp/p2r5-source-freeze-20260913','COURSEKIT_CONTENT_ROOT':'/Users/mannbellani/freelingo-wt/p2r5-integration/content'});assert r.returncode==0
