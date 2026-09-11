import ExpoModulesCore

/**
 Backup exclusion for the pack cache (INV-PACK-11, INV-PER-06).

 There is no first-party Expo API for this. On iOS the flag is per-file and is set at
 runtime through `URLResourceValues.isExcludedFromBackup`; on Android exclusion can only
 be *declared*, in `res/xml/backup_rules.xml` and `res/xml/data_extraction_rules.xml`,
 which this module's config plugin (`app.plugin.js`) writes at prebuild.

 The function returns the flag read back from the file system, never the value we just
 tried to write, so a silent no-op cannot report success.
 */
public class BackupExclusionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackupExclusion")

    AsyncFunction("setExcludedFromBackup") { (path: String) -> Bool in
      var url = Self.fileURL(from: path)
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw PathNotFoundException(path)
      }

      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)

      let readBack = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
      return readBack.isExcludedFromBackup ?? false
    }
  }

  /// Accepts both a `file://` URI (what `expo-file-system`'s `Paths` hands out) and a
  /// bare POSIX path.
  private static func fileURL(from path: String) -> URL {
    if let url = URL(string: path), url.isFileURL {
      return url.standardizedFileURL
    }
    return URL(fileURLWithPath: path).standardizedFileURL
  }
}

internal final class PathNotFoundException: GenericException<String> {
  override var reason: String {
    "No file or directory to exclude from backup at: \(param)"
  }
}
