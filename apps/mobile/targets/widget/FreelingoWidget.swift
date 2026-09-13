import Foundation
import SwiftUI
import WidgetKit

private enum WidgetPresentationPolicy {
  // Initial native layout policy, 2026-09-13; device font-scale QA remains required.
  static let numeralSize:CGFloat=36
  static let numeralFloor:CGFloat=24
  static let reloadKind="FreelingoWidget"
}
private struct SnapshotEntry:TimelineEntry {let date:Date;let snapshotJson:String?}
private enum SharedSnapshotReader {
  static func read()->String? {
    guard let group=Bundle.main.object(forInfoDictionaryKey:"FreelingoWidgetAppGroup") as? String,
      let directory=FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:group),
      let handle=try? FileHandle(forReadingFrom:directory.appendingPathComponent("FreelingoWidget/publication-v1.json")) else{return nil}
    defer{try? handle.close()}
    guard let bytes=try? handle.read(upToCount:262_145),bytes.count<=262_144,
      let value=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],value["schemaVersion"] as? Int==1,
      let raw=value["snapshotJson"] as? String else{return nil}
    return raw
  }
}
private struct SnapshotProvider:TimelineProvider {
  func placeholder(in context:Context)->SnapshotEntry {SnapshotEntry(date:Date(),snapshotJson:nil)}
  func getSnapshot(in context:Context,completion:@escaping(SnapshotEntry)->Void){completion(SnapshotEntry(date:Date(),snapshotJson:SharedSnapshotReader.read()))}
  func getTimeline(in context:Context,completion:@escaping(Timeline<SnapshotEntry>)->Void){
    let now=Date(),zone=TimeZone.current,raw=SharedSnapshotReader.read()
    var dates=[now]
    if WidgetSnapshotModel.snapshot(raw) != nil,let end=WidgetSnapshotModel.boundary(now,zone){
      let calendar=WidgetSnapshotModel.calendar(zone),start=calendar.startOfDay(for:now)
      dates += [12,18].compactMap{calendar.date(bySettingHour:$0,minute:0,second:0,of:start)}
      dates += [240,180,120,60,45,30,15].map{end.addingTimeInterval(-Double($0)*60)}
      dates.append(end)
    }
    let entries=Set(dates.filter{$0>=now}).sorted().map{SnapshotEntry(date:$0,snapshotJson:raw)}
    completion(Timeline(entries:entries,policy:.atEnd))
  }
}
private struct SnapshotView:View {
  let entry:SnapshotEntry
  @Environment(\.widgetFamily) private var family
  @ScaledMetric(relativeTo:.largeTitle) private var numeralSize=WidgetPresentationPolicy.numeralSize
  private var model:WidgetViewState {
    // Never render a baked `remainingMinutes`: obtain current time and zone here.
    WidgetSnapshotModel.render(raw:entry.snapshotJson,nowMs:Date().timeIntervalSince1970*1000,zone:TimeZone.current.identifier)
  }
  private func colour(_ m:WidgetViewState)->Color {
    switch m.flame {case "lit":return Color(red:1,green:0.59,blue:0);case "frozen":return .blue;default:return .secondary}
  }
  private func symbol(_ m:WidgetViewState)->String {m.flame=="frozen" ? "snowflake" : m.flame=="none" ? "bird.fill" : "flame.fill"}
  private func copy(_ m:WidgetViewState)->String {
    // Cached WidgetKit views cannot attest a newly changed zone. Keep urgency non-time
    // instead of shipping a baked numeric countdown; the model still covers each state.
    ["NUDGE","DANGER"].contains(m.state) ? "Practice today to extend your streak." : m.copy
  }
  var body:some View {
    let m=model
    Group {
      if family == .accessoryCircular {
        VStack(spacing:1){Image(systemName:symbol(m));if let n=m.streak{Text(String(n)).font(.system(size:20,weight:.heavy,design:.rounded)).lineLimit(1).minimumScaleFactor(1).layoutPriority(1)}}
      }else if family == .accessoryInline {
        HStack {Image(systemName:symbol(m));Text(m.streak.map{String($0)+" day streak"} ?? "Open Freelingo")}
      }else {
       VStack(spacing:6){
        HStack(alignment:.center,spacing:12){
          VStack(spacing:4){
            Image(systemName:symbol(m)).font(.system(size:28,weight:.bold)).foregroundStyle(colour(m))
            if let n=m.streak {Text(String(n)).font(.system(size:numeralSize,weight:.heavy,design:.rounded)).lineLimit(1).minimumScaleFactor(min(1,WidgetPresentationPolicy.numeralFloor/numeralSize)).layoutPriority(1).foregroundStyle(colour(m))}
          }.layoutPriority(1)
          if family != .systemSmall {Text(copy(m)).font(.system(.headline,design:.rounded)).lineLimit(4).multilineTextAlignment(.leading)}
        }
        if family == .systemSmall {Text(copy(m)).font(.system(.caption,design:.rounded)).lineLimit(3).multilineTextAlignment(.center)}
       }
      }
    }
    .padding(family == .systemSmall || family == .systemMedium ? 12:0)
    .widgetURL(URL(string:m.deepLink))
    .accessibilityLabel(copy(m))
    .environment(\.locale,Locale(identifier:"en_US_POSIX"))
    .modifier(WidgetBackground())
  }
}
private struct WidgetBackground:ViewModifier {
  @ViewBuilder func body(content:Content)->some View {
    if #available(iOS 17.0,*){content.containerBackground(.background,for:.widget)}else{content.background(Color.white)}
  }
}
@main struct FreelingoWidget:Widget {
  var body:some WidgetConfiguration {
    StaticConfiguration(kind:WidgetPresentationPolicy.reloadKind,provider:SnapshotProvider()){entry in SnapshotView(entry:entry)}
      .configurationDisplayName("Freelingo")
      .description("Your streak and daily goal, stored on this device.")
      .supportedFamilies([.systemSmall,.systemMedium,.accessoryCircular,.accessoryRectangular,.accessoryInline])
  }
}
