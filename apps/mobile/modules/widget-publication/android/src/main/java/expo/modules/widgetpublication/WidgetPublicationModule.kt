package expo.modules.widgetpublication

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.runBlocking
import java.util.concurrent.Executors

class WidgetPublicationModule:Module() {
  private val executor=Executors.newCachedThreadPool()
  private var storage:WidgetPublicationStorage?=null
  private var destroyed=false
  @Synchronized private fun store():WidgetPublicationStorage {
    check(!destroyed){"Widget module destroyed"}
    storage?.let{return it}
    val context=appContext.reactContext?:error("Widget application context unavailable")
    return WidgetPublicationStorage(WidgetDataStore.port(context)).also{storage=it}
  }
  private fun task(promise:Promise,body:()->Any?) {
    try{executor.execute{try{val result=body();promise.resolve(if(result==Unit)null else result)}catch(e:Throwable){promise.reject("ERR_WIDGET_PUBLICATION",e.message,e)}}}
    catch(e:Throwable){promise.reject("ERR_WIDGET_PUBLICATION",e.message,e)}
  }
  override fun definition()=ModuleDefinition {
    Name("WidgetPublication")
    AsyncFunction("acquire"){promise:Promise->task(promise){store().acquire()}}
    AsyncFunction("read"){token:String,promise:Promise->task(promise){store().read(token)}}
    AsyncFunction("write"){token:String,json:String,promise:Promise->task(promise){store().write(token,json)}}
    AsyncFunction("reload"){token:String,promise:Promise->task(promise){
      store().markReload(token)
      val context=appContext.reactContext?:error("Widget application context unavailable")
      runBlocking{FreelingoWidget().updateAll(context)}
    }}
    AsyncFunction("release"){token:String,promise:Promise->task(promise){store().release(token)}}
    OnDestroy{synchronized(this@WidgetPublicationModule){destroyed=true;storage?.invalidate();storage=null};executor.shutdownNow()}
  }
}
