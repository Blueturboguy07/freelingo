from pathlib import Path
import hashlib,json
BASE=Path('/Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913-revision-2')
OUT=Path('/private/tmp/p3-spanish-revision-review')
def canonical(x): return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(x):return hashlib.sha256(canonical(x).encode()).hexdigest()
def filehash(x):return hashlib.sha256(x.read_bytes()).hexdigest()
def rows(name):return [json.loads(x) for x in (BASE/'bundle'/name).read_text().splitlines()]
cand=rows('candidates.jsonl');surfaces=rows('surface-catalog.jsonl');lexical=rows('lexical-catalog.jsonl')
sources=json.loads((BASE/'bundle/sources.json').read_text());first=json.loads((BASE/'bundle/first-session.json').read_text())
sf={x['surfaceId']:x for x in surfaces};lx={x['lexemeId']:x for x in lexical}
assert len(cand)==11 and len(sources)==11 and len(lx)==7
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
  assert p['introduction']=='word'
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
assert first['exerciseIds']==[c['proposedExercise']['exercise_id'] for c in cand[:3]]
assert [c['proposedExercise']['slot_index'] for c in cand[:3]]==[0,1,2]
checks={'candidates':11,'sources':len(sources),'surfaces':len(sf),'lexicalDeclarations':len(lx),'lexicalBindings':bindings,'exactSourceHashes':'passed','sourcePlacementAndResponseJoin':'passed','surfaceRanksAndVisibleIntroductions':'passed','wordSemanticIds':'passed','recognitionOptionDisjointness':'passed','sourceApprovalIssued':False,'assemblyReady':False}
(OUT/'checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(checks))

from collections import Counter
reviewer='Codex independent Spanish revision reviewer /root'
candidate_notes=[
 ('accepted','The displayed Spanish hola has exactly one correct offered meaning, hello; hi is also accepted. English day/night are unambiguously different distractors.'),
 ('accepted','The displayed Spanish día has exactly one correct offered meaning, day; hello/night are different distractors.'),
 ('accepted','The displayed Spanish noche has exactly one correct offered meaning, night; hello/day are different distractors. Evening is not used as a false distractor.'),
 ('accepted','The arrival greeting Hola, buenas noches is correctly paired with Hello, good evening for its declared evening-greeting reading.'),
 ('accepted','Adiós, buenas noches is a coherent departure; the reversed Spanish order retains both goodbye and good-night functions.'),
 ('accepted','Sí, por favor and Por favor, sí express the requested polite affirmative. Both concrete orders are now accepted.'),
 ('accepted','Using the Spanish prompt Ella es buena removes the previous ambiguous English-to-Spanish wellbeing requirement; the listed English good-person, good and kind readings are defensible.'),
 ('accepted','The Spanish meeting formulas Encantado, mucho gusto receive natural English meeting greetings rather than a forced repeated literal formula.'),
 ('rejected','The unrestricted reverse prompt Bien, gracias. ¿Y tú? and explanation expressly include well, but neither Well, thank you. And you? nor Well, thanks. And you? occurs in the proposed answers. Ordinary contracted replies such as I\'m fine, thanks. And you? are also absent. Author and review these exact response-language alternatives; this is a missing-answer-set finding, not a claim that a compiled grader ran.'),
 ('rejected','Bien. ¿Y tú? admits the common wellbeing response I\'m good. And you? (and I am good. And you?). The set includes short Good but omits these ordinary expanded equivalents while admitting expanded fine and well. Author and review these exact English alternatives.'),
 ('accepted','Mucho gusto, señor is a coherent respectful meeting greeting; the listed English nice/pleased/pleasure-to-meet-you variants preserve sir.'),
]
records=[]
def add(kind,identity,obj,verdict,note,**extra):
 records.append({'kind':kind,'identity':identity,'contentSha256':digest(obj),'reviewer':reviewer,'verdict':verdict,'note':note,**extra})
for index,c in enumerate(cand):
 d=c['draft'];eid=d['record']['exercise_id'];sid=d['sourceId'];src=sources[sid];verdict,note=candidate_notes[index]
 add('candidate',{'exerciseId':eid,'index':index},c,verdict,note,approvedForProduction=False)
 add('explanation',{'exerciseId':eid},d['explanation'],'accepted','The explanation accurately describes the displayed Spanish greeting, lexical meaning, gender/agreement or wellbeing function. This approves its stated linguistic explanation, not completeness of the candidate answer set.')
 add('schedulerObjective',{'exerciseId':eid},d['schedulerObjective'],'accepted','The selected lexeme occurs in the actual Spanish source and has the reviewed contextual meaning. Source hashes and the exact Spanish surface join pass. Current upstream source/lexical approvals and teaching history are still required.')
 for b in d['lexicalBindings']:
  add('lexicalBinding',{'exerciseId':eid,'surfaceId':b['surfaceId']},b,'accepted','The exact Spanish surface contains the declared target lexeme in context and maps to the same semantic word identity. Countability applies to that lexeme, not all words in the sentence.')
 pair={'text':src['text'],'translation':src['translation']}
 add('sourceLanguagePair',{'sourceId':sid},pair,'accepted','The whole Spanish source and preferred English translation express the intended greeting, courtesy, wellbeing or lexical reading.',sourceObjectSha256=digest(src),issuesNativeSourceApproval=False)
for l in lexical:
 add('lexicalDeclaration',{'lexemeId':l['lexemeId']},l,'accepted','The declared lemma, contextual part of speech and citation meaning are sound: hola greeting; día day; noche night; favor noun within por favor; bueno good adjective; gusto pleasure in meeting formula; bien wellbeing adverb. This approves the declared lexical sense and semantic word identity only, not parser regeneration or a G6 source approval.')
for s in surfaces:
 add('surfaceDeclaration',{'surfaceId':s['surfaceId']},s,'accepted','The exact authored form is valid for its linked source and declared response or Spanish display role. Valid individual forms do not prove that the candidate answer set is complete. Prompt introduction is a possible observed location, never a fabricated teaching receipt.')
add('firstSessionDeclaration',{'nodeId':first['nodeId']},first,'rejected','All three sources are suitable recognition introductions, but the exact three-exercise proposal is not launchable: the current unmodified lesson generator requires six and returns offered=false/nothingDue with a fresh empty due pool. Supply a complete eligible authored first-session population and reconcile the preserved three-level/six-session path. Keep the production delay and session floor unchanged.',approvedForProduction=False)
(OUT/'decisions.jsonl').write_text(''.join(canonical(x)+'\n' for x in records))
manifest={'schemaVersion':1,'reviewer':reviewer,'reviewedAt':'2026-09-13','sourceCommit':'c0c5c5dd0741793bad19de362b7de96fdf2b0996','scope':'Independent linguistic/component and first-session population review only; no G6/source approval, paid native review, pack assembly or phase gate','nativeReviewLabel':'PROVISIONAL (unreviewed by a paid native speaker)','assemblyReady':False,'candidateDecisions':dict(Counter(x[0] for x in candidate_notes)),'decisionCounts':dict(Counter(x['kind'] for x in records)),'files':{str(p.relative_to(BASE)):filehash(p) for p in sorted(BASE.rglob('*')) if p.is_file()},'decisionsSha256':filehash(OUT/'decisions.jsonl'),'checksSha256':filehash(OUT/'checks.json'),'generationWitnessSha256':filehash(OUT/'first-session.test.ts'),'pending':['Two English reverse answer sets need ordinary alternatives','Three-exercise starter fails the actual lesson minimum of six','Current whole-source/alternate G6 and lexical-source approval routes','Reviewed profiles, dictionaries, teaching policy and credits','Full preserved path/source-population reconciliation and actual introduction history for later production','G7/G9 integration and fresh full validators/300-item scoring','Paid native review before release']}
(OUT/'review-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'candidateDecisions':manifest['candidateDecisions'],'decisions':len(records)}))
