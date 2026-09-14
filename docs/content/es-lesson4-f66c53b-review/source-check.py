import json,hashlib,collections
from pathlib import Path
import coursekit.adapters.spacy_es as adapter_module
import coursekit.stages.g5_gapfill as axes
from coursekit.adapters.spacy_es import build
from coursekit.artifacts import dedup_hash,sentence_id
from coursekit.config.g5 import min_tokens_for_slot
root=Path('/Users/mannbellani/freelingo-wt/p2-es-lesson4/content/es/grading/first-unit-20260914-lesson4-authoring')
load=lambda p:json.loads(p.read_text());rows=lambda p:[json.loads(x) for x in p.read_text().splitlines() if x]
digest=lambda x:hashlib.sha256(json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
facts=load(root/'source-inputs.json');auth=load(root/'authoring.json');raw=rows(root/'raw-g5-proposals.jsonl');slots={x['selected']['slot_index']:x['selected'] for x in facts['sourceSlots']}
full=Path('/private/tmp/p2r5-source-freeze-20260913/es');banded=rows(full/'g2/banded.jsonl');pos={x['lemma']:x['pos'] for x in banded};selected=[x for x in rows(full/'g4/selected.jsonl') if x['unit_index']==1];ids={x['sentence_id'] for x in selected if not x['gap']};seen=set()
with (full/'g0/ingested.jsonl').open() as handle:
 for line in handle:
  r=json.loads(line)
  if r['sentence_id'] in ids:seen.add(dedup_hash(r['text']))
analyser=build();analyser.require_self_test();checks=[]
for i,r in enumerate(raw,1):
 slot=r['slot']['slot_index'];gap=slots[slot];sid=sentence_id('es',r['text']);minimum=min_tokens_for_slot(gap['known_lemmas'],gap['new_lemmas'],pos)
 source={**r,'lang':'es','accepted_alternates':[]}
 reject,analysis=axes._axis(source,gap,analyser,seen,sid,minimum,required_unit=facts['unit'])
 unknown=[] if analysis is None else sorted(set(analysis['lemmas'])-set(gap['known_lemmas'])-set(gap['new_lemmas']))
 checks.append({'row':i,'slot':r['slot'],'sourceRowSha256':digest(r),'text':r['text'],'translation':r['translation'],'minimumTokens':minimum,'axisReject':reject,'analysis':analysis,'unknownLemmas':unknown})
lexical=[]
for r in auth['recognitionAdditions']:
 a=analyser.analyse(sentence_id=sentence_id('es',r['text']),text=r['text']);lexical.append({'lexemeId':r['lexemeId'],'sourceRowSha256':digest(r),'analysis':a,'matchesDeclaredLemma':r['lemma'] in a['lemmas'],'matchesDeclaredPOS':any(t['lemma']==r['lemma'] and t['pos']==r['pos'] for t in a['tokens'])})
report={'authorCommit':'f66c53b79357f9f5e1ecadde00604dcd0fad5307','adapter':analyser.fingerprint(),'adapterSourceSha256':hashlib.sha256(Path(adapter_module.__file__).read_bytes()).hexdigest(),'g5SourceSha256':hashlib.sha256(Path(axes.__file__).read_bytes()).hexdigest(),'corpusDuplicateSetSize':len(seen),'canonicalChecks':checks,'lexicalChecks':lexical,'axisCounts':dict(collections.Counter(r['axisReject'] or 'pass' for r in checks)),'compatibleBySlot':{str(k):sum(r['slot']['slot_index']==k and r['axisReject'] is None for r in checks) for k in slots if k>=4},'G5StageRan':False,'G6Approval':False}
Path('/private/tmp/p3-lesson4-source-review.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:report[k] for k in ('axisCounts','compatibleBySlot')},ensure_ascii=False));print(json.dumps([{'lexemeId':r['lexemeId'],'lemmaMatch':r['matchesDeclaredLemma'],'posMatch':r['matchesDeclaredPOS'],'tokens':r['analysis']['tokens']} for r in lexical],ensure_ascii=False))
