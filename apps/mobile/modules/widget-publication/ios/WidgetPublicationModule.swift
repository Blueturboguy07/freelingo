import ExpoModulesCore
import Foundation
import WidgetKit

public final class WidgetPublicationModule: Module {
  private let guardLock=NSLock()
  private var storage:AtomicWidgetPublication?
  private var destroyed=false
  private func store() throws -> AtomicWidgetPublication {
    guardLock.lock();defer{guardLock.unlock()}
    guard !destroyed else{throw WidgetPublicationError("Module is destroyed")}
    if let storage{return storage}
    guard let group=Bundle.main.object(forInfoDictionaryKey:"FreelingoWidgetAppGroup") as? String,
      let container=FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:group)
      else{throw WidgetPublicationError("Shared widget App Group is unavailable")}
    let result=try AtomicWidgetPublication(directory:container.appendingPathComponent("FreelingoWidget",isDirectory:true))
    storage=result;return result
  }
  public func definition() -> ModuleDefinition {
    Name("WidgetPublication")
    AsyncFunction("acquire") { (promise:Promise) in
      do {
        let source=try self.store()
        // A blocked file lease must not block the serial Expo queue needed to release it.
        DispatchQueue.global(qos:.utility).async {
          do{promise.resolve(try source.acquire())}catch{promise.reject(error)}
        }
      }catch{promise.reject(error)}
    }
    AsyncFunction("read") { (token:String) -> String? in try self.store().read(token:token) }
    AsyncFunction("write") { (token:String,json:String) in try self.store().write(token:token,json:json) }
    AsyncFunction("reload") { (token:String) in
      try self.store().markReload(token:token)
      // WidgetKit acknowledges the request synchronously; this is not a draw receipt.
      WidgetCenter.shared.reloadTimelines(ofKind:"FreelingoWidget")
    }
    AsyncFunction("release") { (token:String) in try self.store().release(token:token) }
    OnDestroy {
      self.guardLock.lock();defer{self.guardLock.unlock()}
      self.destroyed=true;self.storage?.invalidate();self.storage=nil
    }
  }
}
private final class WidgetPublicationError: GenericException<String> {
  override var reason:String {param}
}
