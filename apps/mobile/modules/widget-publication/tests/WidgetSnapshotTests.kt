import expo.modules.widgetpublication.WidgetSnapshotModel
import java.io.File
import org.json.JSONArray
fun main(args:Array<String>){
 val rows=JSONArray(File(args[0]).readText())
 for(i in 0 until rows.length()){
  val row=rows.getJSONObject(i);val raw=row.opt("snapshotJson") as? String
  val actual=WidgetSnapshotModel.render(raw,row.getLong("nowMs"),row.getString("zone")).json()
  val expected=row.getJSONObject("expected")
  for(key in expected.keys()){
   val a=actual.get(key);val b=expected.get(key)
   val equal=if(a is Number && b is Number)a.toDouble()==b.toDouble() else a==b
   check(equal){"[INV-WID-01/02/03/06/10] ${row.getString("name")} $key expected $b got $a"}
  }
 }
 println("PASS: ${rows.length()} Kotlin snapshot state/time/route conformance fixtures")
}
