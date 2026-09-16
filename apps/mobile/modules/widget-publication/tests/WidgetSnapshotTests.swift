import Foundation
@main struct WidgetSnapshotTests {
 static func main() throws {
  let data=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]));let cases=try JSONSerialization.jsonObject(with:data) as! [[String:Any]]
  for row in cases {
   let actual=WidgetSnapshotModel.render(raw:row["snapshotJson"] as? String,nowMs:row["nowMs"] as! Double,zone:row["zone"] as! String)
   guard NSDictionary(dictionary:actual.json).isEqual(to:row["expected"] as! [AnyHashable:Any]) else {fatalError("[INV-WID-01/02/03/06/10] \(row["name"]!): \(actual.json)")}
  }
  print("PASS: \(cases.count) Swift snapshot state/time/route conformance fixtures")
 }
}
