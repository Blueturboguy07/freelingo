package expo.modules.widgetpublication

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** No application/database model enters the target; this is the closed snapshot wire. */
data class WidgetViewState(val state:String,val copy:String,val streak:Long?,val flame:String,
 val goalMet:Boolean,val remainingMinutes:Long?,val deepLink:String,val cosmeticId:String?) {
 fun json()=JSONObject().put("state",state).put("copy",copy).put("streak",streak?:JSONObject.NULL)
  .put("flame",flame).put("goalMet",goalMet).put("remainingMinutes",remainingMinutes?:JSONObject.NULL)
  .put("deepLink",deepLink).put("cosmeticId",cosmeticId?:JSONObject.NULL)
}
object WidgetSnapshotModel {
 // Source: core WIDGET_POLICY (Freelingo policy, 2026-09-11), closed wire 2026-09-13.
 const val MAX_SNAPSHOT_CODE_UNITS=8192
 val UNKNOWN=WidgetViewState("UNKNOWN","Open Freelingo",null,"none",false,null,"freelingo://open",null)
 private val fields=setOf("initialized","local_day","computed_at_utc","tz_id","day_boundary_utc","streak","last_completed_local_day","freezes_owned","previous_day_disposition","streak_extended_today","goal_met","earned_xp","goal_xp","lifetime_sessions","active_course_id","active_node_id","has_resumable_session","equipped_cosmetic_id")
 private fun day(v:Any?):String?=try{(v as? String)?.takeIf{it.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && LocalDate.parse(it).toString()==it}}catch(_:Exception){null}
 private fun integer(v:Any?):Long? {
  if(v !is Number)return null
  val n=v.toDouble();return if(n.isFinite() && n>=0 && n<=9007199254740991.0 && n==kotlin.math.floor(n))n.toLong() else null
 }
 private fun identifier(v:Any?):String?=(v as? String)?.takeIf{it.trim().isNotEmpty() && it.length<=1024 && it.none{c->c.code<32 || c.code==127} && validUnicode(it)}
 private fun validUnicode(s:String):Boolean {
  var i=0
  while(i<s.length){if(s[i].isHighSurrogate()){if(i+1>=s.length || !s[i+1].isLowSurrogate())return false;i+=2}else{if(s[i].isLowSurrogate())return false;i++}}
  return true
 }
 private fun nullableString(v:Any?)=v as? String
 private fun encode(s:String)=URLEncoder.encode(s,StandardCharsets.UTF_8.toString()).replace("+","%20").replace("%21","!").replace("%27","'").replace("%28","(").replace("%29",")").replace("%7E","~")
 private fun boundary(at:Instant,zone:ZoneId)=at.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
 fun snapshot(raw:String?):JSONObject?=try{
  require(raw!=null && raw.length<=MAX_SNAPSHOT_CODE_UNITS)
  val v=JSONObject(raw);require(v.keys().asSequence().toSet()==fields)
  require(v.get("initialized")==true && day(v.get("local_day"))!=null)
  val computed=Instant.parse(v.getString("computed_at_utc"));val originalZone=ZoneId.of(v.getString("tz_id"))
  require(computed.atZone(originalZone).toLocalDate().toString()==v.getString("local_day"))
  require(boundary(computed,originalZone)==Instant.parse(v.getString("day_boundary_utc")))
  for(key in listOf("streak","freezes_owned","earned_xp","goal_xp","lifetime_sessions"))require(integer(v.get(key))!=null)
  require(v.getLong("goal_xp")>0)
  for(key in listOf("streak_extended_today","goal_met","has_resumable_session"))require(v.get(key) is Boolean)
  require(identifier(v.get("active_course_id"))!=null)
  for(key in listOf("active_node_id","equipped_cosmetic_id"))require(v.get(key)===JSONObject.NULL || identifier(v.get(key))!=null)
  require(v.get("previous_day_disposition")===JSONObject.NULL || v.get("previous_day_disposition") in listOf("completed","frozen","missed"))
  val last=v.get("last_completed_local_day")
  require(last===JSONObject.NULL || (day(last)!=null && (last as String)<=v.getString("local_day")))
  if(v.getLong("lifetime_sessions")==0L)require(v.getLong("streak")==0L && !v.getBoolean("streak_extended_today") && last===JSONObject.NULL)
  v
 }catch(_:Exception){null}
 fun render(raw:String?,nowMs:Long,zoneName:String):WidgetViewState {return try{
  val v=snapshot(raw)?:return UNKNOWN;val zone=ZoneId.of(zoneName);val now=Instant.ofEpochMilli(nowMs)
  if(now.atZone(zone).toLocalDate().toString()!=v.getString("local_day") || now<Instant.parse(v.getString("computed_at_utc")))return UNKNOWN
  val remaining=kotlin.math.ceil((boundary(now,zone).toEpochMilli()-nowMs)/60000.0).toLong();val hour=now.atZone(zone).hour
  val count=v.getLong("streak");val goal=v.getBoolean("goal_met");val course=encode(v.getString("active_course_id"))
  val link=when{v.getBoolean("has_resumable_session")->"freelingo://resume?course=$course";goal->"freelingo://practice?course=$course";else->"freelingo://path?course=$course"+(nullableString(v.get("active_node_id"))?.let{"&node="+encode(it)}?:"")}
  fun result(state:String,copy:String,flame:String="unlit",streak:Long?=count)=WidgetViewState(state,copy,streak,flame,goal,remaining,link,nullableString(v.get("equipped_cosmetic_id")))
  when {
   v.getLong("lifetime_sessions")==0L->result("COLD","Tap to start","none",null)
   v.getBoolean("streak_extended_today")->if(goal)result("DONE","$count day streak!","lit") else result("STREAK_SAFE_GOAL_UNMET","Streak safe — ${maxOf(0,v.getLong("goal_xp")-v.getLong("earned_xp"))} XP to your goal","lit")
   count==0L->result("LOST","Revive your streak!")
   v.getLong("freezes_owned")>0->result("FROZEN","Your Streak Freeze is ready","frozen")
   v.get("previous_day_disposition")=="frozen" && hour<12->result("FROZEN","A Streak Freeze protected yesterday. Practice today!","frozen")
   remaining<=240->{val limit=listOf(15,30,45,60,120,180,240).firstOrNull{remaining<=it}?:240;val time=if(limit>=60)"${limit/60} ${if(limit==60)"hour" else "hours"}" else "$limit minutes";if(remaining<=60)result("DANGER","Less than $time until your $count day streak is lost!")else result("NUDGE","Less than $time to extend your $count day streak!")}
   hour<12->result("IDLE_MORNING","Practice every day to build your streak.")
   else->result(if(hour<18)"IDLE_AFTERNOON" else "IDLE_EVENING","Practice each day so your streak won't reset!")
  }
 }catch(_:Exception){UNKNOWN}
 }
}
