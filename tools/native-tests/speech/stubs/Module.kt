package expo.modules.kotlin.modules
import android.os.Bundle
import expo.modules.kotlin.Promise
import expo.modules.speech.SpeechOptions
open class Module {
 class Context { val reactContext:Any?=null };val appContext=Context();val events=mutableListOf<Pair<String,Bundle>>()
 open fun definition():ModuleDefinition=ModuleDefinition{}
 fun sendEvent(name:String,value:Bundle){events.add(Pair(name,value))}
}
class ModuleDefinition(body:ModuleDefinition.()->Unit) {
 var onDestroy:(()->Unit)?=null
 val functions=mutableMapOf<String,(Array<out Any?>)->Any?>();init{body()}
 fun Name(n:String){};fun Events(vararg n:String){};fun Constant(n:String,b:()->Any?){};fun OnActivityDestroys(b:()->Unit){onDestroy=b}
 fun <T> AsyncFunction(n:String,b:()->T){functions[n]={b()}}
 fun AsyncFunction(n:String,b:(Promise)->Unit){functions[n]={b(it[0] as Promise)}}
 fun AsyncFunction(n:String,b:(String,String,SpeechOptions)->Unit){functions[n]={b(it[0] as String,it[1] as String,it[2] as SpeechOptions)}}
 fun call(n:String,vararg args:Any?)=functions.getValue(n)(args)
}
