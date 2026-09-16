package android.speech.tts
import android.os.Bundle
import java.util.Locale
class Voice(val name:String,val locale:Locale,val quality:Int=300,val isNetworkConnectionRequired:Boolean=false,val features:Set<String> = emptySet()) { companion object { const val QUALITY_NORMAL=300 } }
open class UtteranceProgressListener { open fun onStart(id:String){};open fun onRangeStart(id:String,start:Int,end:Int,frame:Int){};open fun onDone(id:String){};open fun onStop(id:String,interrupted:Boolean){};open fun onError(id:String){} }
class TextToSpeech(context:Any?, val init:(Int)->Unit) {
 companion object { const val SUCCESS=0;const val ERROR=-1;const val LANG_MISSING_DATA=-1;const val LANG_NOT_SUPPORTED=-2;const val QUEUE_ADD=1;fun getMaxSpeechInputLength()=4000;lateinit var latest:TextToSpeech }
 object Engine { const val KEY_PARAM_VOLUME="volume";const val KEY_FEATURE_NOT_INSTALLED="notInstalled" }
 init { latest=this }
 var voices:Set<Voice> = emptySet(); var selected:Voice?=null;val voice:Voice? get()=selected
 var language:Locale=Locale.US;var isSpeaking=false;var setVoiceCode=SUCCESS;var speakCode=SUCCESS;var redirect:Voice?=null
 val spoken=mutableListOf<Pair<String,String>>();var stops=0
 var beforeSetVoice:(()->Unit)?=null
 @Volatile var stopReturned=false; @Volatile var spokeAfterStop=false
 var shutdowns=0
 fun setVoice(v:Voice):Int { beforeSetVoice?.invoke(); if(setVoiceCode==SUCCESS)selected=redirect?:v;return setVoiceCode }
 fun setPitch(v:Float)=SUCCESS; fun setSpeechRate(v:Float)=SUCCESS;fun isLanguageAvailable(v:Locale)=SUCCESS
 fun speak(text:String,queue:Int,params:Bundle,id:String):Int { if(stopReturned)spokeAfterStop=true;spoken.add(Pair(id,text));return speakCode }
 fun stop():Int {stops++;return SUCCESS};fun shutdown(){shutdowns++};fun setOnUtteranceProgressListener(l:UtteranceProgressListener)=SUCCESS
}
