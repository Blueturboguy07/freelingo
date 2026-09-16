import Foundation
import CoreFoundation

struct WidgetViewState {
  var state:String;var copy:String;var streak:Int?;var flame:String
  var goalMet:Bool;var remainingMinutes:Int?;var deepLink:String;var cosmeticId:String?
  var json:[String:Any] { ["state":state,"copy":copy,"streak":streak as Any? ?? NSNull(),
    "flame":flame,"goalMet":goalMet,"remainingMinutes":remainingMinutes as Any? ?? NSNull(),
    "deepLink":deepLink,"cosmeticId":cosmeticId as Any? ?? NSNull()] }
}
/// Foundation-only target model. Only the closed snapshot enters this boundary.
/// Thresholds mirror WIDGET_POLICY (Freelingo conservative policy, 2026-09-11).
struct WidgetSnapshotModel {
  static let maximumSnapshotCodeUnits=8192
  static let unknown=WidgetViewState(state:"UNKNOWN",copy:"Open Freelingo",streak:nil,flame:"none",goalMet:false,remainingMinutes:nil,deepLink:"freelingo://open",cosmeticId:nil)
  static let fields=Set(["initialized","local_day","computed_at_utc","tz_id","day_boundary_utc","streak","last_completed_local_day","freezes_owned","previous_day_disposition","streak_extended_today","goal_met","earned_xp","goal_xp","lifetime_sessions","active_course_id","active_node_id","has_resumable_session","equipped_cosmetic_id"])
  static func date(_ value:String)->Date? {
    let format=ISO8601DateFormatter();format.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
    if let result=format.date(from:value){return result}
    format.formatOptions=[.withInternetDateTime];return format.date(from:value)
  }
  static func calendar(_ zone:TimeZone)->Calendar {var c=Calendar(identifier:.gregorian);c.timeZone=zone;c.locale=Locale(identifier:"en_US_POSIX");return c}
  static func day(_ date:Date,_ zone:TimeZone)->String {
    let parts=calendar(zone).dateComponents([.year,.month,.day],from:date)
    return String(format:"%04d-%02d-%02d",locale:Locale(identifier:"en_US_POSIX"),parts.year!,parts.month!,parts.day!)
  }
  static func validDay(_ value:Any?)->Bool {
    guard let s=value as? String,s.range(of:#"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#,options:.regularExpression) != nil,
      let parsed=date(s+"T12:00:00Z") else{return false}
    return day(parsed,TimeZone(secondsFromGMT:0)!)==s
  }
  static func boundary(_ date:Date,_ zone:TimeZone)->Date? {calendar(zone).dateInterval(of:.day,for:date)?.end}
  static func integer(_ value:Any?)->Int? {
    guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID() else{return nil}
    let d=n.doubleValue;guard d.isFinite,d>=0,d<=9_007_199_254_740_991,d.rounded()==d else{return nil};return Int(d)
  }
  static func boolean(_ value:Any?)->Bool? {
    guard let n=value as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{return nil};return n.boolValue
  }
  static func identifier(_ value:Any?)->String? {
    guard let s=value as? String,!s.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,s.utf16.count<=1024,
      !s.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}) else{return nil};return s
  }
  static func encode(_ s:String)->String {s.addingPercentEncoding(withAllowedCharacters:CharacterSet(charactersIn:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"))!}
  static func snapshot(_ raw:String?)->[String:Any]? {
    guard let raw,raw.utf16.count<=maximumSnapshotCodeUnits,let bytes=raw.data(using:.utf8),
      let parsed=try? JSONSerialization.jsonObject(with:bytes),let v=parsed as? [String:Any],Set(v.keys)==fields,
      boolean(v["initialized"])==true,validDay(v["local_day"]),
      let computedText=v["computed_at_utc"] as? String,let computed=date(computedText),
      let boundaryText=v["day_boundary_utc"] as? String,let declaredBoundary=date(boundaryText),
      let zoneText=v["tz_id"] as? String,let zone=TimeZone(identifier:zoneText),
      let currentDay=v["local_day"] as? String,day(computed,zone)==currentDay,
      boundary(computed,zone)==declaredBoundary else{return nil}
    for key in ["streak","freezes_owned","earned_xp","goal_xp","lifetime_sessions"] {guard integer(v[key]) != nil else{return nil}}
    guard integer(v["goal_xp"])!>0 else{return nil}
    for key in ["streak_extended_today","goal_met","has_resumable_session"] {guard boolean(v[key]) != nil else{return nil}}
    guard identifier(v["active_course_id"]) != nil else{return nil}
    for key in ["active_node_id","equipped_cosmetic_id"] {guard v[key] is NSNull || identifier(v[key]) != nil else{return nil}}
    let previous=v["previous_day_disposition"]
    guard previous is NSNull || ["completed","frozen","missed"].contains(previous as? String ?? "") else{return nil}
    let last=v["last_completed_local_day"]
    guard last is NSNull || (validDay(last) && (last as! String)<=currentDay) else{return nil}
    if integer(v["lifetime_sessions"])==0 && (integer(v["streak"]) != 0 || boolean(v["streak_extended_today"])==true || !(last is NSNull)){return nil}
    return v
  }
  static func render(raw:String?,nowMs:Double,zone:String)->WidgetViewState {
    guard nowMs.isFinite,let zone=TimeZone(identifier:zone),let v=snapshot(raw) else{return unknown}
    let now=Date(timeIntervalSince1970:nowMs/1000)
    guard day(now,zone)==v["local_day"] as? String,date(v["computed_at_utc"] as! String)!<=now,
      let end=boundary(now,zone) else{return unknown}
    let remaining=Int(ceil(end.timeIntervalSince(now)/60)),hour=calendar(zone).component(.hour,from:now)
    let count=integer(v["streak"])!,course=encode(v["active_course_id"] as! String),goal=boolean(v["goal_met"])!
    let link:String
    if boolean(v["has_resumable_session"])! {link="freelingo://resume?course="+course}
    else if goal {link="freelingo://practice?course="+course}
    else {link="freelingo://path?course="+course+((v["active_node_id"] as? String).map{"&node="+encode($0)} ?? "")}
    var out=WidgetViewState(state:"",copy:"",streak:count,flame:"unlit",goalMet:goal,remainingMinutes:remaining,deepLink:link,cosmeticId:v["equipped_cosmetic_id"] as? String)
    if integer(v["lifetime_sessions"])==0 {out.state="COLD";out.copy="Tap to start";out.streak=nil;out.flame="none"}
    else if boolean(v["streak_extended_today"])! {
      out.flame="lit"
      if goal {out.state="DONE";out.copy="\(count) day streak!"}
      else {out.state="STREAK_SAFE_GOAL_UNMET";out.copy="Streak safe — \(max(0,integer(v["goal_xp"])!-integer(v["earned_xp"])!)) XP to your goal"}
    }else if count==0 {out.state="LOST";out.copy="Revive your streak!"}
    else if integer(v["freezes_owned"])!>0 {out.state="FROZEN";out.flame="frozen";out.copy="Your Streak Freeze is ready"}
    else if v["previous_day_disposition"] as? String == "frozen" && hour<12 {out.state="FROZEN";out.flame="frozen";out.copy="A Streak Freeze protected yesterday. Practice today!"}
    else if remaining<=240 {
      let limit=[15,30,45,60,120,180,240].first(where:{remaining<=$0}) ?? 240
      let time=limit>=60 ? "\(limit/60) \(limit==60 ? "hour":"hours")":"\(limit) minutes"
      out.state=remaining<=60 ? "DANGER":"NUDGE"
      out.copy=remaining<=60 ? "Less than \(time) until your \(count) day streak is lost!":"Less than \(time) to extend your \(count) day streak!"
    }else if hour<12 {out.state="IDLE_MORNING";out.copy="Practice every day to build your streak."}
    else {out.state=hour<18 ? "IDLE_AFTERNOON":"IDLE_EVENING";out.copy="Practice each day so your streak won't reset!"}
    return out
  }
}
