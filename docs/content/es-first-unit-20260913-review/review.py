import hashlib,json
from pathlib import Path
from collections import Counter
BASE=Path('/Users/mannbellani/freelingo-wt/p6-media/content/es/grading/first-unit-20260913')
OUT=Path('/private/tmp/p3-spanish-first-unit-review')
def canonical(x): return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(x): return hashlib.sha256(canonical(x).encode()).hexdigest()
def bytes_hash(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def rows(name): return [json.loads(x) for x in (BASE/'bundle'/name).read_text().splitlines()]
candidates=rows('candidates.jsonl');lexical=rows('lexical-catalog.jsonl');surfaces=rows('surface-catalog.jsonl');facts=json.loads((BASE/'bundle/source-facts.json').read_text());path=json.loads((BASE/'bundle/path-candidate.json').read_text())
lex={x['lexemeId']:x for x in lexical};sf={x['surfaceId']:x for x in surfaces};byid={x['draft']['record']['exercise_id']:x for x in candidates}
assert len(byid)==20 and len(lex)==8 and len(sf)==39
amendments=[];bindings=0
for c in candidates:
 d=c['draft']; eid=d['record']['exercise_id']; f=facts['exercises'][eid]; r=f['exercise'];src=f['source'];p=d['presentation'];objective=d['schedulerObjective']; sid=d['sourceId']
 assert d['record']==f['record']
 assert d['sourceSha256']==digest(src) and sid==f['sourceId']==r['source_sentence_id']==src['sqlSentence']['sentence_id']
 assert src['text']==src['sqlSentence']['text'] and src['translation']==src['sqlSentence']['translation']
 assert p['itemId']==r['item_id'] and d['record']['prompt']==r['prompt']==p['instruction']+'\n'+p['prompt']
 assert p['type']=='typedTranslate' and p['language']==d['responseLanguage']
 assert d['record']['lesson_index']==r['lesson_index']==src['lesson_index']
 assert d['record']['unit_index']==f['unit']['unit_index']==src['unit_index']
 answers=c['proposedAnswers']; assert [x['rank'] for x in answers]==list(range(len(answers)))
 assert p['acceptedAnswers']==[x['surface'] for x in answers] and len(set(p['acceptedAnswers']))==len(answers)
 assert p['acceptedAnswers'][0]==r['preferred_surface']
 if p['acceptedAnswers']!=json.loads(r['accepted_answers_json']):amendments.append(eid)
 forward=d['shapeId']=='typed_translate_forward'
 assert p['prompt']==src['translation' if forward else 'text']
 assert d['responseLanguage']==('es' if forward else 'en')
 assert p['promptLanguage']==('en' if forward else 'es')
 assert c['introduction']==('wrong-feedback' if forward else 'prompt')
 assert objective['exerciseId']==eid and objective['sourceId']==sid and objective['sourceSha256']==digest(src)
 if objective['kind']=='lexeme':
  l=lex[objective['itemRef']]; assert any(x['lexeme_id']==l['lexemeId'] and x['lemma']==l['lemma'] and x['pos']==l['pos'] for x in f['lexemes'])
  assert any(x['lemma']==l['lemma'] and x['pos']==l['pos'] for x in src['analysis']['tokens'])
 else: assert objective['itemRef']=='gc:'+f['g3']['grammar_concept'] and not d['lexicalBindings']
 expected=[('es',x['surface']) for x in answers] if forward else [('es',src['text'])]
 assert [(sf[x['surfaceId']]['language'],sf[x['surfaceId']]['surface']) for x in d['schedulerSurfaces']]==expected
 assert [x['canonical'] for x in d['schedulerSurfaces']]==[True]+[False]*(len(expected)-1)
 for i,b in enumerate(d['lexicalBindings']):
  bindings+=1;l=lex[b['lexemeId']]
  assert b['exerciseId']==eid and b['sourceId']==sid and b['sourceSha256']==digest(src)
  assert b['wordItemId']==l['wordItemId'] and b['schedulerItemId']==r['item_id']
  assert b['surfaceId']==d['schedulerSurfaces'][i]['surfaceId']
  assert {'sourceId':sid,'sourceSha256':digest(src)} in l['sources']
 for x in d['surfaceIds']:
  assert x in sf and sid in sf[x]['sourceIds']
for s in surfaces:
 assert s['surfaceId']=='sf_'+digest([s['language'],s['surface']])[:32]
 intro=s['introduction']
 if intro:
  d=byid[intro['exerciseId']]['draft'];r=d['record'];f=facts['exercises'][r['exercise_id']]
  assert s['language']=='es' and s['surface']==f['source']['text']
  assert intro['unitId']==f['exercise']['unit_id'] and intro['lessonIndex']==r['lesson_index']
  assert s['surface']==(d['presentation']['prompt'] if intro['when']=='prompt' else d['presentation']['acceptedAnswers'][0])
for l in lexical:
 assert l['wordItemId']=='i_'+digest({k:sorted(v) if isinstance(v,list) else v for k,v in l['semantic'].items()})[:16]
 assert l['countable']==(l['classification']=='word')
pathids=[]
for section in path['sections']:
 for unit in section['units']:
  for node in unit['nodes']:
   for session in node['sessions']:
    expected=sorted([f['exercise'] for f in facts['exercises'].values() if f['exercise']['lesson_index']==session['lessonIndex']],key=lambda x:(x['slot_index'],x['exercise_id']))
    assert session['exerciseIds']==[r['exercise_id'] for r in expected];pathids+=session['exerciseIds']
assert len(pathids)==20 and set(pathids)==set(byid)
checks={'candidateCount':20,'lexicalCount':8,'surfaceCount':39,'lexicalBindingCount':bindings,'sourceAndPlacementJoin':'passed','rankAndSurfaceJoin':'passed','wordSemanticHashJoin':'passed','pathSubsetExactOrdering':'passed','sourceAmendments':amendments,'missingCurrentG6Approvals':20,'recognitionCandidates':0,'productionCandidates':20,'runnableFirstEverPath':False,'replayLog':'/private/tmp/p3-spanish-authoring-replay.log','replayExit':int(Path('/private/tmp/p3-spanish-authoring-replay.exit').read_text())}
(OUT/'checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
reviewer='Codex independent reviewer /root/review_g7_integration'
# These are the independent decisions from reading each full pair, its visible
# explanation, catalogs and exact source snapshots. No model or generated review input.
decisions=[
('rejected','meaning/pragmatics','Hello, good night combines an arrival greeting with the English leaving/bedtime formula. Spanish Hola, buenas noches is an evening greeting. The displayed prompt does not support the explanation as written; author a natural evening-greeting source pair and obtain new source/identity/G6 proof.',[]),
('accepted','bounded-clear','Both Hello and Hi preserve this afternoon greeting; canonical-first ranks are reasonable. The bueno objective is attested as buenas. Frozen hola/tarde POS concerns remain upstream and are not approved here.',[]),
('rejected','naturalness/context','Hello, yes. Goodbye and Hola, sí. Adiós are a pile of greeting/answer/farewell fragments without the turns or context that would make them a useful standalone sentence. Preserve the source, but author a coherent prompt/source or real dialogue before learner use.',[]),
('accepted','bounded-clear','Please, please faithfully repeats the fixed phrase por favor. The lexical objective is the noun component favor, with the catalog explicitly distinguishing it from the entire phrase meaning.',[]),
('accepted','bounded-clear','Sí, buenos días and Yes, good morning are a possible polite response followed by a morning greeting. The día/buenos gender explanation is correct; context would improve pedagogy but no meaning defect is found.',[]),
('rejected','accepted-answer-omission','The standalone prompt Please, yes has no word-order constraint. Sí, por favor is an equally natural affirmative polite reply; the only proposed answer forces the unusual reverse order. Add reviewed whole-sentence evidence or provide real dialogue context that constrains the intended form.',['Sí, por favor.']),
('accepted','bounded-clear','Both Yo no soy tú and No soy tú preserve I am not you; the omitted first-person subject is licensed by soy. Both rank and grammar-objective evidence are sound.',[]),
('accepted','bounded-clear','Spanish Yo soy bueno explicitly selects the good-quality/character reading. Both I am good and its contraction are valid English answers. The explanation is appropriate for masculine bueno.',[]),
('rejected','prompt-sense/accepted-answer','She\'s good is also an ordinary response about her condition/wellbeing, whereas Ella es buena / Es buena selects quality or character. The prompt supplies no sense cue. Narrow the source prompt to the reviewed intended meaning, or independently approve whole-sentence alternatives for its supported readings; do not add estar forms directly in G7.',['Ella está bien.','Está bien.']),
('accepted','bounded-clear','It\'s not us and It is not us preserve the identity-denial meaning of No somos nosotros. The contraction rank and subject-pronoun explanation are appropriate.',[]),
('accepted','bounded-clear','No eres yo and Tú no eres yo both preserve You\'re not me. Correct nominative yo after ser and optional tú are explained. No additional register is inferred from English you.',[]),
('accepted','bounded-clear','Nombre, por favor is an idiomatic short name request. The preferred answer and nombre objective are sound. No claim is made that the set exhausts every context-dependent expanded request.',[]),
('accepted','bounded-clear','Señor, por favor is a respectful address followed by please; no explicit usted conjugation is introduced. The primary favor objective avoids the known incorrect Señor POS snapshot, which still needs upstream repair.',[]),
('accepted','bounded-clear','Madam and ma\'am are appropriate English vocatives for Señora here; canonical-first ranks are acceptable. The primary objective remains favor, and no approval is given to the preserved Señora POS defect.',[]),
('accepted','bounded-clear','Bien por ti is a valid congratulatory Good for you. The ti-versus-tú explanation is correct. Health-benefit and other contextual good-for-you readings are not asserted as this declared intended sense.',[]),
('rejected','naturalness/preference','The preferred English Pleased to meet you, a pleasure is stiff, and the alternate Pleased to meet you, nice to meet you merely repeats the same meeting formula. Author one natural full bilingual exchange/utterance and its legitimate English set before selecting a preferred answer.',[]),
('rejected','accepted-answer-omission','Fine, thank you. And you? permits the ordinary Spanish subject/predicate expansion Estoy bien, gracias. ¿Y tú?. That full answer is absent. This needs authored whole-sentence evidence and current policy validation; it is not permission to insert an unvalidated estar form.',['Estoy bien, gracias. ¿Y tú?']),
('rejected','accepted-answer-omission','Bien. ¿Y tú? permits ordinary Good. And you? and I\'m fine. And you? as replies about wellbeing. Fine and Well alone do not cover these straightforward equivalents. Independently approve the exact English reverse-only forms.',['Good. And you?',"I'm fine. And you?",'I am fine. And you?']),
('rejected','naturalness/source','The English prompt A pleasure and see you later is unnatural as a first-unit meeting/farewell sentence. Mucho gusto y hasta luego is interpretable, but should be paired with a natural explicitly authored English meeting/parting utterance and new source proof.',[]),
('accepted','bounded-clear','You are not good, You aren\'t good and You\'re not good preserve the explicit Spanish bueno quality reading. Canonical plus both common contractions is appropriate; no Spanish surface is inferred from these English variants.',[]),
]
assert len(decisions)==len(candidates)
records=[]
def add(kind,identity,obj,verdict,notes,**extra):
 h=digest({k:v for k,v in obj.items() if k!='review'})
 records.append({'kind':kind,**identity,'sha256':h,'review':{'reviewer':reviewer,'verdict':verdict,'sha256':h},'notes':notes,**extra})
for index,(c,decision) in enumerate(zip(candidates,decisions),1):
 d=c['draft'];eid=d['record']['exercise_id'];verdict,category,note,witnesses=decision
 add('candidate',{'exerciseId':eid},c,verdict,[note],row=index,category=category,omittedAnswerWitnesses=witnesses,approvedForProduction=False)
 add('explanation',{'exerciseId':eid},d['explanation'],'accepted',['The linguistic statement itself is correct for the indicated Spanish sense. This component decision does not approve the complete prompt/answer pair; see its candidate decision.'])
 add('schedulerObjective',{'exerciseId':eid},d['schedulerObjective'],'accepted',['Exact source/SQL lexeme or declared grammar objective is present in the intended canonical Spanish source. Production scheduling still requires actual target introduction and the unchanged four-hour delay.'])
 for i,b in enumerate(d['lexicalBindings']):
  add('lexicalBinding',{'exerciseId':eid,'bindingIndex':i,'lexemeId':b['lexemeId'],'surfaceId':b['surfaceId']},b,'accepted',['Exact declared target lexeme occurs in this canonical or explicitly proposed Spanish answer; scheduler item, source hash and semantic word hash join. This is authoring evidence only, not alternate G6 or learner-display evidence.'])
for l in lexical:
 notes=['Reviewed lemma, contextual meaning, source/POS binding and semantic word identity; countability applies to the declared lexical unit, not the aggregate sentence scheduler ID.']
 if l['lemma']=='sí':notes+=['Accept affirmative response sí as a noncountable response particle for EC-ECO-32. INTJ is the preserved current corpus/SQL tag, not a claim that every grammar tradition uses INTJ; RAE calls affirmative sí an adverb.']
 if l['lemma']=='favor':notes+=['The catalog correctly qualifies please as the whole expression por favor, not an isolated dictionary assertion favor=please.']
 add('lexicalCatalog',{'lexemeId':l['lexemeId']},l,'accepted',notes)
for s in surfaces:
 bad=s['language']=='en' and s['sourceIds']==['6bbd9b14d1bf53fa']
 add('surfaceCatalog',{'surfaceId':s['surfaceId']},s,'rejected' if bad else 'accepted', ['Unnatural repeated meeting formula is not approved as a preferred/alternate English response; see candidate ba369b2c6536fec7.'] if bad else ['Surface spelling/language and explicit preference rank reviewed. Any introduction witness joins the actual visible Spanish prompt or canonical wrong-feedback text. It is a potential display location only, not proof of observation, a complete answer set, source approval, or production eligibility.'])
add('pathDeclaration',{'courseId':'en-es'},path,'rejected',['The 20-row subset joins exactly to the declared six lessons in source slot order, but all shapes are production typedTranslate and no recognition/new-word introduction source is present. It cannot start a first-ever course under INV-SCH-10. Neither the subset 9-point ceiling nor very early A1 label receives product approval from this authoring review.'],approvedForProduction=False)
(OUT/'decisions.jsonl').write_text(''.join(canonical(r)+'\n' for r in records))
meta={'schemaVersion':1,'reviewer':reviewer,'reviewedAt':'2026-09-13','sourceCommit':'7dc0bd2e37119fce64e764daf517549d5a980249','scope':'independent authoring judgments only; no G6, source approval, profile/dictionary approval, learner observation or phase gate','nativeReviewLabel':'PROVISIONAL (unreviewed by a paid native speaker)','assemblyReady':False,'hashAlgorithm':'sha256(canonical UTF-8 JSON, sorted keys, compact separators, ensure_ascii=false; exclude only future top-level review)','files':{str(p.relative_to(BASE)):bytes_hash(p) for p in [BASE/'authoring.json',BASE/'bundle/manifest.json',BASE/'bundle/candidates.jsonl',BASE/'bundle/lexical-catalog.jsonl',BASE/'bundle/surface-catalog.jsonl',BASE/'bundle/source-facts.json',BASE/'bundle/path-candidate.json']},'candidateDecisions':dict(Counter(x[0] for x in decisions)),'decisionCounts':dict(Counter(x['kind'] for x in records)),'decisionsSha256':bytes_hash(OUT/'decisions.jsonl'),'checksSha256':bytes_hash(OUT/'checks.json'),'pending':['Eight candidate source/answer/naturalness revisions need author adjudication','Every current complete selected source and alternate needs current G6/answer approval','Existing source POS defects need upstream regeneration','Reviewed normalized grading profile and complete dictionary/credit policy still absent','Actual recognition introductions and delay-compatible first-course path remain absent','Full V1–V12 and 300-item fresh pack scoring not run by this review','Paid native review remains release prerequisite']}
(OUT/'review-manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'checks':checks,'candidateDecisions':meta['candidateDecisions'],'decisions':len(records)},ensure_ascii=False,indent=2))
