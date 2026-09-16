import android.speech.tts.*
import expo.modules.speech.*
import expo.modules.kotlin.Promise
import java.util.Locale
val offline=Voice("es-installed",Locale.forLanguageTag("es-ES"))
val cloud=Voice("es-network",Locale.forLanguageTag("es-ES"),isNetworkConnectionRequired=true)
val absent=Voice("es-download",Locale.forLanguageTag("es-ES"),features=setOf(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED))
fun options(voice:String?)=SpeechOptions("es-ES",1f,1f,voice,1f)
class Rig(ready:Boolean=true) {
 val module=SpeechModule();val api=module.definition();val promise=Promise();val tts:TextToSpeech
 init {api.call("getVoices",promise);tts=TextToSpeech.latest;tts.voices=setOf(offline,cloud,absent);if(ready)tts.init(TextToSpeech.SUCCESS)}
 fun say(voice:String?=offline.name)=api.call("speak","utterance","Hola",options(voice))
 fun failed()=module.events.any{it.first==speakingErrorEvent && it.second.values["id"]=="utterance"}
}
fun main() {
 val cases=linkedMapOf<String,()->Unit>(
  "[INV-AUD-01] only installed offline voices are advertised" to {val r=Rig();check((r.promise.value as List<*>).map{(it as VoiceRecord).identifier}==listOf(offline.name))},
  "[INV-AUD-01] network voice cannot synthesize" to {val r=Rig();r.say(cloud.name);check(r.tts.spoken.isEmpty()&&r.failed())},
  "[INV-AUD-01] pending download voice cannot synthesize" to {val r=Rig();r.say(absent.name);check(r.tts.spoken.isEmpty()&&r.failed())},
  "[INV-AUD-02] missing explicit voice reports unavailable" to {val r=Rig();r.say(null);check(r.tts.spoken.isEmpty()&&r.failed())},
  "[INV-AUD-02] disappeared voice never uses previous voice" to {val r=Rig();r.tts.selected=offline;r.say("deleted");check(r.tts.spoken.isEmpty()&&r.failed())},
  "[INV-AUD-02] failed voice selection never speaks" to {val r=Rig();r.tts.setVoiceCode=TextToSpeech.ERROR;r.say();check(r.tts.spoken.isEmpty()&&r.failed())},
  "[INV-AUD-01] native engine fallback is rejected" to {val r=Rig();r.tts.redirect=cloud;r.say();check(r.tts.spoken.isEmpty()&&r.failed())},
  "[INV-AUD-02] synchronous synthesis rejection reports failure" to {val r=Rig();r.tts.speakCode=TextToSpeech.ERROR;r.say();check(r.failed())},
  "[INV-PER-09] cancelling pending initialization discards queued speech" to {val r=Rig(false);r.say();r.api.call("stop");r.tts.init(TextToSpeech.SUCCESS);check(r.tts.spoken.isEmpty())},
  "[INV-PER-09] stop cannot return before pending native initialization handoff" to {
   val r=Rig(false);r.say()
   val reached=java.util.concurrent.CountDownLatch(1)
   val release=java.util.concurrent.CountDownLatch(1)
   r.tts.beforeSetVoice={reached.countDown();release.await()}
   val init=kotlin.concurrent.thread{r.tts.init(TextToSpeech.SUCCESS)}
   check(reached.await(2,java.util.concurrent.TimeUnit.SECONDS))
   val stopped=java.util.concurrent.CountDownLatch(1)
   val stop=kotlin.concurrent.thread{r.api.call("stop");r.tts.stopReturned=true;stopped.countDown()}
   stopped.await(200,java.util.concurrent.TimeUnit.MILLISECONDS)
   release.countDown();init.join();stop.join()
   check(!r.tts.spokeAfterStop){"Pending onInit synthesized AFTER stop returned"}
  },
  "[INV-PER-09] destroyed module cannot revive pending speech or voices" to {
   val r=Rig(false);r.say();r.api.onDestroy!!.invoke();r.tts.init(TextToSpeech.SUCCESS)
   val promise=Promise();r.api.call("getVoices",promise);r.say()
   check(r.tts.shutdowns==1 && r.tts.spoken.isEmpty() && (promise.value as List<*>).isEmpty() && r.failed())
  },
  "[INV-AUD-01] installed requested voice speaks exact text" to {val r=Rig();r.say();check(r.tts.spoken==listOf(Pair("utterance","Hola")) && r.tts.selected==offline && !r.failed())}
 )
 var failures=0
 for((name,run) in cases)try{run();println("PASS $name")}catch(e:Throwable){failures++;println("FAIL $name: $e")}
 println("${cases.size-failures}/${cases.size} passed")
 if(failures>0)throw IllegalStateException("$failures native speech counterexamples")
}
