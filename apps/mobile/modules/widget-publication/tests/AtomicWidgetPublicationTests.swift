import Foundation
import Dispatch
@main struct WidgetStorageTests {
 static func check(_ value: Bool,_ message:String) {if !value{fatalError(message)}}
 static func main() throws {
  let directory=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
  try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
  let first=try AtomicWidgetPublication(directory:directory), second=try AtomicWidgetPublication(directory:directory)
  do{_ = try first.read(token:"wrong");fatalError("[INV-WID-04] no lease accepted")}catch{}
  let token=try first.acquire()
  check(try first.read(token:token)==nil,"[INV-WID-10] first launch invented a snapshot")
  let raw="{\"schemaVersion\":1,\"snapshotJson\":null,\"attemptsMs\":[100],\"lastRenderedKey\":null,\"pendingKey\":\"new-state\"}"
  try first.write(token:token,json:raw)
  check(try first.read(token:token)==raw,"[INV-WID-01] durable whole record mismatch")
  for malformed in ["{}",raw.replacingOccurrences(of:"[100]",with:"[2,1]"),raw.replacingOccurrences(of:"[100]",with:"[true]"),raw.replacingOccurrences(of:"[100]",with:"["+Array(repeating:"100",count:41).joined(separator:",")+"]")]{
   do{try first.write(token:token,json:malformed);fatalError("[INV-WID-04] corrupt budget accepted")}catch{}
  }
  check(try first.read(token:token)==raw,"[INV-WID-01] rejected write changed durable record")
  let entered=DispatchSemaphore(value:0),finish=DispatchSemaphore(value:0)
  DispatchQueue.global().async {do {let next=try second.acquire();entered.signal();try second.release(token:next);finish.signal()}catch{fatalError("native lock: \(error)")}}
  check(entered.wait(timeout:.now()+0.1) == .timedOut,"[INV-WID-04] concurrent native lease bypassed lock")
  try first.release(token:token)
  check(entered.wait(timeout:.now()+2) == .success,"[INV-WID-04] queued native lease did not resume")
  check(finish.wait(timeout:.now()+2) == .success,"[INV-WID-04] queued native lease did not release")
  do{try first.release(token:token);fatalError("[INV-WID-04] stale release accepted")}catch{}
  let reopened=try AtomicWidgetPublication(directory:directory);let held=try reopened.acquire()
  check(try reopened.read(token:held)==raw,"[INV-WID-01] process-style reopen lost reservation")
  try reopened.write(token:held,json:raw)
  try reopened.markReload(token:held)
  do{try reopened.markReload(token:held);fatalError("[INV-WID-04] same lease reloaded twice")}catch{}
  try reopened.release(token:held)
  let abandoned=try reopened.acquire()
  reopened.invalidate()
  do{_ = try reopened.read(token:abandoned);fatalError("[INV-WID-04] destroyed module lease stayed valid")}catch{}
  let newModule=try AtomicWidgetPublication(directory:directory),newToken=try newModule.acquire()
  try newModule.release(token:newToken)
  print("PASS: native atomic storage, lock, reopen and module-destruction checks [INV-WID-01/04/10]")
 }
}
