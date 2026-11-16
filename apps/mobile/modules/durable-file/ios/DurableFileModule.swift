import Darwin
import ExpoModulesCore
import Foundation

/// Prepares the folder in Application Support that holds kept.db, and returns its path. The folder is excluded from
/// backup, and its protection, which SQLite's files take from it, opens them from the first unlock after a restart.
public final class DurableFileModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DurableFile")
    AsyncFunction("prepareFolder") { () throws -> String in
      do {
        return try prepareFolder()
      } catch let error as CocoaError where error.code == .fileWriteNoPermission || error.code == .fileReadNoPermission {
        throw locked
      }
    }
  }
}

private let locked = Exception(name: "DurableFileLocked", description: "The phone hasn't been unlocked since it started.", code: "ERR_DURABLE_LOCKED")

private func failed(_ step: String) -> Exception {
  Exception(name: "DurableFileFailed", description: "Couldn't \(step): \(String(cString: strerror(errno))).", code: "ERR_DURABLE_FAILED")
}

/// Creates the folder and kept.db if missing, then syncs each folder whose entries changed, so the file survives power
/// loss before SQLite's first commit. Opening kept.db here also tells a locked phone from a damaged file: SQLite would
/// report both as failing to open.
private func prepareFolder() throws -> String {
  let fileManager = FileManager.default
  let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  var folder = support.appendingPathComponent("dohc-kept", isDirectory: true)
  let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
  try fileManager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: protection)
  try fileManager.setAttributes(protection, ofItemAtPath: folder.path)
  var values = URLResourceValues()
  values.isExcludedFromBackup = true
  try folder.setResourceValues(values)
  let fd = Darwin.open(folder.appendingPathComponent("kept.db").path, O_RDONLY | O_CREAT | O_CLOEXEC, 0o600)
  if fd < 0 { throw errno == EPERM || errno == EACCES ? locked : failed("open kept.db") }
  _ = Darwin.close(fd)
  for directory in [support.deletingLastPathComponent(), support, folder] { try syncDirectory(directory) }
  return folder.path
}

/// F_FULLFSYNC also flushes the drive's cache. Plain fsync stands in only where the file system refuses it for a folder.
private func syncDirectory(_ directory: URL) throws {
  let fd = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { throw failed("open the folder") }
  defer { _ = Darwin.close(fd) }
  if Darwin.fcntl(fd, F_FULLFSYNC) != -1 { return }
  guard errno == ENOTSUP || errno == ENOTTY || errno == EINVAL else { throw failed("flush the folder") }
  guard fsync(fd) == 0 else { throw failed("sync the folder") }
}
