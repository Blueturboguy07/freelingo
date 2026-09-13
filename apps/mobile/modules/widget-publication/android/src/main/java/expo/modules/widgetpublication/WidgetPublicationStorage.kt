package expo.modules.widgetpublication

import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Semaphore

/** App-only whole-record port. The production implementation is one DataStore edit. */
interface WidgetRecordPort { fun read():String?; fun write(json:String) }
class WidgetPublicationStorage(private val port:WidgetRecordPort) {
  private val owner=UUID.randomUUID().toString()
  private var disposed=false
  private data class Lease(val owner:String,val token:String,var wrote:Boolean=false,var reloaded:Boolean=false)
  companion object {
    private val queue=Semaphore(1,true)
    private val guard=Any()
    private var current:Lease?=null
    const val MAX_CODE_UNITS=65536 // Freelingo transport policy, 2026-09-13.
    fun decode(json:String):JSONObject {
      require(json.length<=MAX_CODE_UNITS){"Invalid widget publication"}
      val value=JSONObject(json)
      require(value.keys().asSequence().toSet()==setOf("schemaVersion","snapshotJson","attemptsMs","lastRenderedKey","pendingKey")){"Invalid widget publication"}
      val version=value.get("schemaVersion")
      require(version is Number && version.toDouble()==1.0){"Invalid widget publication"}
      for(key in listOf("snapshotJson","lastRenderedKey","pendingKey")){
        val item=value.get(key);require(item is String || item===JSONObject.NULL){"Invalid widget publication"}
      }
      val attempts=value.getJSONArray("attemptsMs");require(attempts.length()<=40){"Invalid widget publication"}
      var previous=Double.NEGATIVE_INFINITY
      for(i in 0 until attempts.length()){
        val item=attempts.get(i);require(item is Number){"Invalid widget publication"}
        val n=item.toDouble();require(n.isFinite() && n==kotlin.math.floor(n) && kotlin.math.abs(n)<=9007199254740991.0 && n>=previous){"Invalid widget publication"};previous=n
      }
      return value
    }
  }
  fun acquire():String {
    synchronized(guard){check(!disposed){"Widget module destroyed"}}
    queue.acquire()
    synchronized(guard){
      if(disposed){queue.release();error("Widget module destroyed")}
      check(current==null){"Widget lease collision"}
      val token=UUID.randomUUID().toString();current=Lease(owner,token);return token
    }
  }
  private fun lease(token:String):Lease {
    val held=current
    check(!disposed && held?.owner==owner && held.token==token){"Widget publication lease required"}
    return held
  }
  fun read(token:String):String?=synchronized(guard){lease(token);port.read()?.also{decode(it)}}
  fun write(token:String,json:String)=synchronized(guard){val held=lease(token);decode(json);port.write(json);held.wrote=true}
  fun markReload(token:String)=synchronized(guard){
    val held=lease(token);check(held.wrote && !held.reloaded){"Widget reload requires a new reservation"}
    val record=decode(port.read()?:error("Missing widget publication"))
    check(record.get("pendingKey") is String && record.getJSONArray("attemptsMs").length()>0){"Missing widget reload reservation"}
    held.reloaded=true
  }
  fun release(token:String)=synchronized(guard){lease(token);current=null;queue.release()}
  fun invalidate()=synchronized(guard){disposed=true;if(current?.owner==owner){current=null;queue.release()}}
}
