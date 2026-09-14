import importlib.util,json,hashlib,traceback
from pathlib import Path
path=Path('/Users/mannbellani/freelingo-wt/p6-media/tools/coursekit/src/coursekit_grading_approvals.py')
spec=importlib.util.spec_from_file_location('approvals',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=m.GradingApprovalAdapter('es')
sources=json.loads(Path('/Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913-revision-3/bundle/sources.json').read_text())
result={'moduleSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'sourceRoot':'/private/tmp/p2r5-source-freeze-20260913','lexical':[],'whole':None}
for sid,s in sources.items():
 if s['sourceKind']!='lexical-authoring-proposal':continue
 try:
  proof=a.project_lexical(s);result['lexical'].append({'sourceId':sid,'text':s['text'],'sourceSha256':m.evidence_digest(s),'valid':a(s,proof),'projection':proof})
 except Exception as e:result['lexical'].append({'sourceId':sid,'text':s['text'],'valid':False,'error':str(e)});traceback.print_exc()
try: a.selected_sources();result['whole']={'approved':True}
except Exception as e:result['whole']={'approved':False,'reason':str(e)}
Path('/private/tmp/p3-grading-approval-live.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'lexical':[{k:r[k] for k in ('text','valid')} for r in result['lexical']],'whole':result['whole']},ensure_ascii=False))
assert len(result['lexical'])==5 and all(r['valid'] for r in result['lexical']) and result['whole']['approved'] is False
