import expo.modules.widgetpublication.WidgetPublicationStorage
import expo.modules.widgetpublication.WidgetRecordPort
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
fun main(){
 var raw:String?=null
 val port=object:WidgetRecordPort{override fun read()=raw;override fun write(json:String){raw=json}}
 val first=WidgetPublicationStorage(port);val second=WidgetPublicationStorage(port)
 val token=first.acquire();check(first.read(token)==null){"[INV-WID-10] invented first snapshot"}
 val record="""{"schemaVersion":1,"snapshotJson":null,"attemptsMs":[100],"lastRenderedKey":null,"pendingKey":"state"}"""
 first.write(token,record);check(first.read(token)==record){"[INV-WID-01] incomplete record"}
 for(bad in listOf("{}",record.replace("[100]","[true]"),record.replace("[100]","[2,1]"),record.replace("[100]","["+List(41){"100"}.joinToString(",")+"]"))){
  check(runCatching{first.write(token,bad)}.isFailure){"[INV-WID-04] malformed budget accepted"}
 }
 val entered=CountDownLatch(1);val done=CountDownLatch(1)
 // A failed main-thread assertion must terminate the harness rather than hang on its lease waiter.
 Thread{val next=second.acquire();entered.countDown();second.release(next);done.countDown()}.apply{isDaemon=true}.start()
 check(!entered.await(100,TimeUnit.MILLISECONDS)){"[INV-WID-04] concurrent lease accepted"}
 first.markReload(token);check(runCatching{first.markReload(token)}.isFailure){"[INV-WID-04] duplicate reload"}
 first.release(token);check(entered.await(2,TimeUnit.SECONDS));check(done.await(2,TimeUnit.SECONDS))
 check(runCatching{first.read(token)}.isFailure){"[INV-WID-04] stale lease read"}
 val abandoned=first.acquire();first.invalidate();check(runCatching{first.write(abandoned,record)}.isFailure)
 val next=second.acquire();check(second.read(next)==record);second.release(next)
 println("PASS: Kotlin storage lease, closed record and module-destruction checks [INV-WID-01/04/10]")
}
