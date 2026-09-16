from pathlib import Path
import hashlib,json
BASE=Path('/Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913-revision-3')
OUT=Path('/private/tmp/p3-spanish-revision3-review')
def canonical(x): return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(x):return hashlib.sha256(canonical(x).encode()).hexdigest()
def filehash(x):return hashlib.sha256(x.read_bytes()).hexdigest()
def rows(name):return [json.loads(x) for x in (BASE/'bundle'/name).read_text().splitlines()]
cand=rows('candidates.jsonl');surfaces=rows('surface-catalog.jsonl');lexical=rows('lexical-catalog.jsonl')
sources=json.loads((BASE/'bundle/sources.json').read_text());first=json.loads((BASE/'bundle/first-session.json').read_text())
sf={x['surfaceId']:x for x in surfaces};lx={x['lexemeId']:x for x in lexical}
assert len(cand)==14 and len(sources)==13 and len(lx)==8
bindings=0
for c in cand:
 d=c['draft'];p=d['presentation'];r=c['proposedExercise'];src=sources[d['sourceId']];sid=d['sourceId'];eid=r['exercise_id']
 assert digest(src)==d['sourceSha256']
 assert d['record']['exercise_id']==eid and d['record']['source_sentence_id']==sid==r['source_sentence_id']
 assert r['item_id']==p['itemId'] and d['record']['prompt']==r['prompt']==p['instruction']+'\n'+p['prompt']
 assert d['record']['lesson_index']==r['lesson_index']==src['lesson_index']
 assert d['record']['unit_index']==src['unit_index']==1
 assert p['language']==d['responseLanguage'] and p['promptLanguage']==('en' if p['language']=='es' else 'es')
 assert p['prompt']==src['translation' if p['language']=='es' else 'text']
 assert p['acceptedAnswers']==json.loads(r['accepted_answers_json'])==[x['surface'] for x in c['proposedAnswers']]
 assert [x['rank'] for x in c['proposedAnswers']]==list(range(len(c['proposedAnswers'])))
 assert r['preferred_surface']==p['acceptedAnswers'][0]
 o=d['schedulerObjective'];l=lx[o['itemRef']]
 assert o['sourceId']==sid and o['sourceSha256']==digest(src) and o['exerciseId']==eid
 assert l['lemma'] in src['analysis']['lemmas']
 for tok in src['analysis']['tokens']:
  assert src['text'][tok['start']:tok['end']]==tok['surface']
 for index,s in enumerate(d['schedulerSurfaces']):
  v=sf[s['surfaceId']]
  assert v['language']=='es' and sid in v['sourceIds']
  assert s['itemId']==p['itemId'] and s['canonical']==(index==0)
  assert v['surface']==(p['acceptedAnswers'][index] if p['language']=='es' else src['text'])
 for b in d['lexicalBindings']:
  bindings+=1
  assert b['exerciseId']==eid and b['sourceId']==sid and b['sourceSha256']==digest(src)
  assert b['schedulerItemId']==p['itemId'] and b['wordItemId']==l['wordItemId']
  assert b['surfaceId'] in [s['surfaceId'] for s in d['schedulerSurfaces']]
  assert {'sourceId':sid,'sourceSha256':digest(src)} in l['sources']
 if p['type']=='meaningSelect':
  assert p['introduction']==('phrase' if p['prompt']=='Hola, buenas noches.' else 'word')
  opts=[o['text'] for o in p['options']]
  assert len(opts)==len(set(opts))==3 and sum(x in p['acceptedAnswers'] for x in opts)==1
  assert r['audio_id'] is None and r['illustration_ref'] is None
for s in surfaces:
 assert s['surfaceId']=='sf_'+digest([s['language'],s['surface']])[:32]
 if s['introduction']:
  intro=s['introduction'];d=next(c['draft'] for c in cand if c['draft']['record']['exercise_id']==intro['exerciseId'])
  assert intro['when']=='prompt' and d['presentation']['prompt']==s['surface']
for l in lexical:
 assert l['wordItemId']=='i_'+digest({k:sorted(v) if isinstance(v,list) else v for k,v in l['semantic'].items()})[:16]
 assert l['classification']=='word' and l['countable'] is True
assert first['exerciseIds']==[c['proposedExercise']['exercise_id'] for c in cand[:3]]+['52c7ff4ef8bd56a1','7177c43944de33ad','cca2f5032a5f0a54']
assert [c['proposedExercise']['slot_index'] for c in cand[:3]]==[0,1,2]
checks={'candidates':14,'sources':len(sources),'surfaces':len(sf),'lexicalDeclarations':len(lx),'lexicalBindings':bindings,'exactSourceHashes':'passed','sourcePlacementAndResponseJoin':'passed','surfaceRanksAndVisibleIntroductions':'passed','wordSemanticIds':'passed','recognitionOptionDisjointness':'passed','sourceApprovalIssued':False,'assemblyReady':False}
(OUT/'checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(checks))


from collections import Counter
OLD=BASE.parent/'first-unit-20260913-revision-2'
prior=json.loads((Path('/private/tmp/p3-spanish-revision-review')/'review-manifest.json').read_text())
prior_decisions=[json.loads(line) for line in (Path('/private/tmp/p3-spanish-revision-review')/'decisions.jsonl').read_text().splitlines()]
old_rows={x['proposedExercise']['exercise_id']:x for x in map(json.loads,(OLD/'bundle/candidates.jsonl').read_text().splitlines())}
old_sources=json.loads((OLD/'bundle/sources.json').read_text())
assert all(sources[key]==value for key,value in old_sources.items())
changed=[];preserved=[]
for c in cand:
 eid=c['proposedExercise']['exercise_id']
 if eid in old_rows:
  (preserved if c==old_rows[eid] else changed).append(eid)
assert set(changed)=={'b03de7ed176e07a1','16f59b19698b62a0'} and len(preserved)==9
for eid in changed:
 old=old_rows[eid];new=next(c for c in cand if c['proposedExercise']['exercise_id']==eid)
 assert old['draft']['presentation']['acceptedAnswers']==new['draft']['presentation']['acceptedAnswers'][:len(old['draft']['presentation']['acceptedAnswers'])]
 for field in ['sourceId','sourceSha256','schedulerObjective','schedulerSurfaces','lexicalBindings','explanation']:
  assert old['draft'][field]==new['draft'][field]
 assert old['proposedExercise']['item_id']==new['proposedExercise']['item_id']
needed={
 'b03de7ed176e07a1':['Well, thank you. And you?','Well, thanks. And you?',"I'm fine, thanks. And you?"],
 '16f59b19698b62a0':["I'm good. And you?",'I am good. And you?']}
for eid,forms in needed.items():
 actual=next(c for c in cand if c['proposedExercise']['exercise_id']==eid)['draft']['presentation']['acceptedAnswers']
 assert all(form in actual for form in forms)
old_surface={x['surfaceId']:x for x in map(json.loads,(OLD/'bundle/surface-catalog.jsonl').read_text().splitlines())}
for sid,row in old_surface.items():
 if row['introduction'] is not None: assert sf[sid]['introduction']==row['introduction']
selected=[next(c for c in cand if c['proposedExercise']['exercise_id']==eid) for eid in first['exerciseIds']]
assert len({c['draft']['presentation']['itemId'] for c in selected})==6
assert len({b['wordItemId'] for c in selected for b in c['draft']['lexicalBindings']})==5
assert len({c['draft']['presentation']['prompt'] for c in selected})==6
assert [c['draft']['presentation']['prompt'] for c in selected]==['hola','día','noche','bueno','tarde','Hola, buenas noches.']
for c in selected:
 d=c['draft'];declaration=sf[d['schedulerSurfaces'][0]['surfaceId']]['introduction']
 assert declaration['exerciseId']==d['record']['exercise_id'] and declaration['when']=='prompt'
checks.update({'preservedCandidates':preserved,'amendedEnglishCandidates':changed,'preservedSourceObjects':len(old_sources),'newSourceObjects':2,'firstSessionExerciseItems':6,'firstSessionLexicalIdentities':5,'firstSessionDisplayedSpanishSurfaces':6,'originalIntroDeclarations':'unchanged','concretePriorEnglishOmissions':'resolved'})
(OUT/'checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
reviewer='Codex independent Spanish revision reviewer /root'
notes={
 'b03de7ed176e07a1':'All concrete prior omissions are supplied. The added well/fine/good replies with thanks or thank you naturally convey this wellbeing response. This accepts these authored alternatives; an exhaustive English paraphrase claim or compiled-grader approval is not made.',
 '16f59b19698b62a0':'The ordinary expanded good replies now join the preserved fine/well alternatives. The concrete prior missing-answer finding is resolved.',
 '52c7ff4ef8bd56a1':'Bueno is good in the declared adjective sense; good is the sole correct offered English meaning, while late and night are distinct. The exact Spanish prompt introduces the cited adjective.',
 '7177c43944de33ad':'Tarde has the declared adverb meaning late. Neither good nor hello is a valid translation; the separate noun meaning afternoon is not used as a false distractor. The explanation explicitly distinguishes the senses.',
 'cca2f5032a5f0a54':'Hola, buenas noches is an arrival greeting rendered naturally as Hello/Hi, good evening. Morning and afternoon are distinct incorrect choices. The explanation correctly describes feminine plural agreement and reuses the noche lexical identity.'}
records=[]
def add(kind,identity,obj,note,**extra):
 sha=digest(obj)
 inherited=next((r for r in prior_decisions if r['kind']==kind and r['contentSha256']==sha and r['verdict']=='accepted'),None)
 records.append({'kind':kind,'identity':identity,'contentSha256':sha,'reviewer':reviewer,'verdict':'accepted','note':note,'approvedForProduction':False,**({'previousExactAcceptedDecisionSha256':digest(inherited)} if inherited else {}),**extra})
for c in cand:
 d=c['draft'];eid=d['record']['exercise_id'];sid=d['sourceId']
 add('candidate',{'exerciseId':eid},c,notes.get(eid,'The exact candidate is unchanged from the independently accepted revision-2 row; its candidate hash and linked source identity are preserved.'))
 add('explanation',{'exerciseId':eid},d['explanation'],'The explanation correctly describes the declared contextual lexical meaning, greeting, agreement or wellbeing reading. Answer completeness and source issuance remain separate checks.')
 add('schedulerObjective',{'exerciseId':eid},d['schedulerObjective'],'The declared target lexeme occurs with the stated contextual sense in the exact hash-bound Spanish source. This is a proposed source binding; current upstream approval and teaching history remain prerequisites.')
 for b in d['lexicalBindings']:
  add('lexicalBinding',{'exerciseId':eid,'surfaceId':b['surfaceId']},b,'The exact Spanish surface contains the declared target and retains its semantic word identity. The greeting variant introduces a new scheduler surface, not a second noche lexical word.')
for sid,src in sources.items():
 add('sourceLanguagePair',{'sourceId':sid},{'text':src['text'],'translation':src['translation']},'The exact Spanish source and preferred English counterpart match the intended greeting, courtesy, wellbeing or declared word sense.',sourceObjectSha256=digest(src),issuesNativeSourceApproval=False)
for l in lexical:
 add('lexicalDeclaration',{'lexemeId':l['lexemeId']},l,'The lemma, part of speech and citation meaning are sound for the declared sense. New tarde is the adverb late; the added bueno source shares the existing good-adjective word identity. This does not approve a parser model or issue a G6 source approval.')
for s in surfaces:
 add('surfaceDeclaration',{'surfaceId':s['surfaceId']},s,'The exact authored surface is valid for its linked source and response/display role. Original introduction declarations remain intact; the greeting declaration is a possible new actual prompt display, never a claimed exposure receipt.')
add('firstSessionDeclaration',{'nodeId':first['nodeId']},first,'The six ordered recognition prompts form a coherent starter using five word identities. The later phrase uses already displayed hola/bueno/noche. This accepts the proposed population only: signed runtime decoding, source approvals, complete preserved path and actual native display are still required.')
(OUT/'decisions.jsonl').write_text(''.join(canonical(r)+'\n' for r in records))
manifest={'schemaVersion':1,'reviewer':reviewer,'reviewedAt':'2026-09-13','sourceCommit':'ec80ac6','priorReviewCommit':'f4bc2f9','scope':'Independent proposed linguistic/component and actual-generator population review; no G6/source issuance, pack or phase gate','nativeReviewLabel':'PROVISIONAL (unreviewed by a paid native speaker)','assemblyReady':False,'candidateDecisions':{'accepted':14,'rejected':0},'preservedExactCandidateDecisions':9,'changedOrNewCandidateDecisions':5,'decisionCounts':dict(Counter(r['kind'] for r in records)),'files':{str(p.relative_to(BASE)):filehash(p) for p in sorted(BASE.rglob('*')) if p.is_file()},'decisionsSha256':filehash(OUT/'decisions.jsonl'),'checksSha256':filehash(OUT/'checks.json'),'pending':['Current G0-G6 complete source approvals and source issuance','Reviewed lexical-source adapter, response profiles/dictionaries and teaching policy','Full preserved three-level/six-session path source-population reconciliation','Actual installed signed pack decoder and native introduction/production flows','G7-G9 integration, full validators and new 300-item scoring','Paid native reviewer before release']}
(OUT/'review-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'candidateDecisions':manifest['candidateDecisions'],'decisions':len(records),'preserved':len(preserved)}))
