import Foundation
import CoreFoundation
import Darwin

/// App-process storage only. Target readers never acquire this lease or call Expo.
/// One atomic file carries snapshot + reload accounting; process death releases flock.
final class AtomicWidgetPublication: @unchecked Sendable {
  static let fileName = "publication-v1.json"
  static let maximumCodeUnits = 65_536 // Freelingo transport policy, 2026-09-13.
  private let directory: URL
  private let mutex = NSLock()
  private var invalidated=false
  private var current: (token:String, descriptor:Int32, wrote:Bool, reloaded:Bool)?
  enum Failure: Error { case lease, publication, io(Int32), duplicateReload }

  init(directory:URL) throws {
    self.directory=directory
    try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,
      attributes:[.posixPermissions:0o700])
    var dir=directory;var values=URLResourceValues();values.isExcludedFromBackup=true
    try dir.setResourceValues(values)
  }
  deinit { if let active=current { _ = flock(active.descriptor,LOCK_UN);_ = close(active.descriptor) } }
  func acquire() throws -> String {
    let descriptor=open(directory.appendingPathComponent("publication.lock").path,O_CREAT|O_RDWR,0o600)
    guard descriptor>=0 else {throw Failure.io(errno)}
    guard flock(descriptor,LOCK_EX)==0 else {let code=errno;_ = close(descriptor);throw Failure.io(code)}
    mutex.lock();defer{mutex.unlock()}
    guard current==nil && !invalidated else{_ = flock(descriptor,LOCK_UN);_ = close(descriptor);throw Failure.lease}
    let token=UUID().uuidString
    current=(token,descriptor,false,false)
    return token
  }
  private func require(_ token:String) throws {
    guard current?.token==token else{throw Failure.lease}
  }
  func read(token:String) throws -> String? {
    mutex.lock();defer{mutex.unlock()};try require(token)
    let file=directory.appendingPathComponent(Self.fileName)
    guard FileManager.default.fileExists(atPath:file.path) else{return nil}
    let bytes=try Data(contentsOf:file)
    guard let json=String(data:bytes,encoding:.utf8) else{throw Failure.publication}
    _ = try Self.decode(json)
    return json
  }
  static func decode(_ json:String) throws -> [String:Any] {
    guard json.utf16.count<=maximumCodeUnits,
      let data=json.data(using:.utf8),
      let value=try JSONSerialization.jsonObject(with:data) as? [String:Any],
      Set(value.keys)==Set(["schemaVersion","snapshotJson","attemptsMs","lastRenderedKey","pendingKey"]),
      let version=value["schemaVersion"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(),version.doubleValue==1,
      let attempts=value["attemptsMs"] as? [Any],attempts.count<=40
      else{throw Failure.publication}
    for key in ["snapshotJson","lastRenderedKey","pendingKey"] {
      guard value[key] is String || value[key] is NSNull else{throw Failure.publication}
    }
    var previous = -Double.infinity
    for attempt in attempts {
      guard let number=attempt as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID()
        else{throw Failure.publication}
      let n=number.doubleValue
      guard n.isFinite,n.rounded()==n,abs(n)<=9_007_199_254_740_991,n>=previous else{throw Failure.publication}
      previous=n
    }
    return value
  }
  func write(token:String,json:String) throws {
    mutex.lock();defer{mutex.unlock()};try require(token);_ = try Self.decode(json)
    let bytes=Data(json.utf8),temp=directory.appendingPathComponent(".publication-"+UUID().uuidString)
    let descriptor=open(temp.path,O_WRONLY|O_CREAT|O_EXCL,0o600)
    guard descriptor>=0 else{throw Failure.io(errno)}
    defer{_ = close(descriptor);try? FileManager.default.removeItem(at:temp)}
    try bytes.withUnsafeBytes { raw in
      var sent=0
      while sent<raw.count {
        let n=Darwin.write(descriptor,raw.baseAddress!.advanced(by:sent),raw.count-sent)
        if n<0 {if errno==EINTR {continue};throw Failure.io(errno)}
        guard n>0 else{throw Failure.io(EIO)};sent += n
      }
    }
    guard fsync(descriptor)==0 else{throw Failure.io(errno)}
    guard rename(temp.path,directory.appendingPathComponent(Self.fileName).path)==0 else{throw Failure.io(errno)}
    let parent=open(directory.path,O_RDONLY)
    guard parent>=0 else{throw Failure.io(errno)}
    defer{_ = close(parent)}
    guard fsync(parent)==0 else{throw Failure.io(errno)}
    current!.wrote=true
  }
  /// Native reload is allowed once per lease, after its durable reservation write.
  func markReload(token:String) throws {
    mutex.lock();defer{mutex.unlock()};try require(token)
    guard current!.wrote && !current!.reloaded else{throw Failure.duplicateReload}
    let file=directory.appendingPathComponent(Self.fileName)
    let value=try Self.decode(String(contentsOf:file,encoding:.utf8))
    guard value["pendingKey"] is String,let attempts=value["attemptsMs"] as? [Any],!attempts.isEmpty
      else{throw Failure.publication}
    current!.reloaded=true
  }
  func invalidate() {
    mutex.lock();defer{mutex.unlock()};invalidated=true
    if let active=current {current=nil;_ = flock(active.descriptor,LOCK_UN);_ = close(active.descriptor)}
  }
  func release(token:String) throws {
    mutex.lock();defer{mutex.unlock()};try require(token)
    let descriptor=current!.descriptor
    current=nil
    let result=flock(descriptor,LOCK_UN),code=errno
    _ = close(descriptor)
    if result != 0 {throw Failure.io(code)}
  }
}
