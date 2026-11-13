import Darwin
import ExpoModulesCore
import Foundation

/// Keeps the outbox's records in a folder in Application Support. A write resolves only once its record is on disk
/// through a closed app, a restart and power loss. Calls run one at a time, in the order JavaScript made them.
public final class DurableFileModule: Module {
  private let queue = DispatchQueue(label: "app.dohc.durable-file")
  private let folder = DurableFolder()

  public func definition() -> ModuleDefinition {
    Name("DurableFile")
    AsyncFunction("write") { (name: String, text: String) throws in
      try coded { try self.folder.write(name, text) }
    }.runOnQueue(queue)
    AsyncFunction("read") { (name: String) throws -> String? in
      try coded { try self.folder.read(name) }
    }.runOnQueue(queue)
    AsyncFunction("list") { () throws -> [String] in
      try coded { try self.folder.list() }
    }.runOnQueue(queue)
    AsyncFunction("remove") { (name: String) throws in
      try coded { try self.folder.remove(name) }
    }.runOnQueue(queue)
    AsyncFunction("recover") { () throws -> [String: [String]] in
      try coded { try self.folder.recover() }
    }.runOnQueue(queue)
    AsyncFunction("removeLeftover") { (fileName: String) throws in
      try coded { try self.folder.removeLeftover(fileName) }
    }.runOnQueue(queue)
  }
}

/// The largest record, in UTF-8 bytes. The binding checks the same number.
let recordMaxBytes = 512 * 1024
private let folderName = "dohc-outbox"

/// What went wrong, as the binding reads it from the error's code.
enum DurableFileFailure: Error {
  case invalid(String)
  case tooLarge
  case unreadable(String)
  case locked
  case failed(String)
  /// The step after the rename failed: the new record may be in place, but isn't known to be durable.
  case unsynced(String)

  var exception: Exception {
    switch self {
    case .invalid(let what): return Exception(name: "DurableFileInvalid", description: what, code: "ERR_DURABLE_INVALID")
    case .tooLarge: return Exception(name: "DurableFileTooLarge", description: "The record is larger than \(recordMaxBytes) bytes.", code: "ERR_DURABLE_TOO_LARGE")
    case .unreadable(let why): return Exception(name: "DurableFileUnreadable", description: why, code: "ERR_DURABLE_UNREADABLE")
    case .locked: return Exception(name: "DurableFileLocked", description: "The phone hasn't been unlocked since it started.", code: "ERR_DURABLE_LOCKED")
    case .failed(let why): return Exception(name: "DurableFileFailed", description: why, code: "ERR_DURABLE_FAILED")
    case .unsynced(let why): return Exception(name: "DurableFileUnsynced", description: why, code: "ERR_DURABLE_UNSYNCED")
    }
  }
}

private func coded<T>(_ body: () throws -> T) throws -> T {
  do {
    return try body()
  } catch let failure as DurableFileFailure {
    throw failure.exception
  } catch {
    throw DurableFileFailure.failed(error.localizedDescription).exception
  }
}

/// Letters, digits, "-" and "_", 1 to 100 of them. A temporary file adds 37 characters, well under the 255-byte limit.
func isRecordName(_ name: String) -> Bool {
  let bytes = name.utf8
  return (1...100).contains(bytes.count) && bytes.allSatisfy { byte in
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
  }
}

/// `<record name>.<32 lowercase hex digits>.tmp`
func isTemporaryName(_ name: String) -> Bool {
  let parts = name.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 3, parts[2] == "tmp", isRecordName(String(parts[0])), parts[1].utf8.count == 32 else { return false }
  return parts[1].utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

private func posix(_ step: String) -> String {
  "Couldn't \(step): \(String(cString: strerror(errno)))."
}

final class DurableFolder {
  private let fileManager = FileManager.default
  private let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
  private let support: URL
  private let url: URL
  /// Set once this run has created the folder or set its protection and backup exclusion.
  private var ready = false

  init() {
    support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    url = support.appendingPathComponent(folderName, isDirectory: true)
  }

  func write(_ name: String, _ text: String) throws {
    guard isRecordName(name) else { throw DurableFileFailure.invalid("The record name isn't valid.") }
    let data = Data(text.utf8)
    guard data.count <= recordMaxBytes else { throw DurableFileFailure.tooLarge }
    try prepareFolder()
    let temp = url.appendingPathComponent("\(name).\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()).tmp")
    let record = url.appendingPathComponent(name)
    let fd = Darwin.open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw DurableFileFailure.failed(posix("create the temporary file")) }
    var isOpen = true
    do {
      try protect(temp)
      try writeAll(fd, data)
      guard Darwin.fcntl(fd, F_FULLFSYNC) != -1 else { throw DurableFileFailure.failed(posix("sync the temporary file")) }
      isOpen = false
      guard Darwin.close(fd) == 0 else { throw DurableFileFailure.failed(posix("close the temporary file")) }
      guard Darwin.rename(temp.path, record.path) == 0 else { throw DurableFileFailure.failed(posix("replace the record")) }
    } catch {
      if isOpen { _ = Darwin.close(fd) }
      _ = Darwin.unlink(temp.path)
      ready = false
      throw error
    }
    try syncAfterChange()
  }

  func read(_ name: String) throws -> String? {
    guard isRecordName(name) else { throw DurableFileFailure.invalid("The record name isn't valid.") }
    guard exists() else { return nil }
    return try readRecord(url.appendingPathComponent(name))
  }

  func list() throws -> [String] {
    guard exists() else { return [] }
    return try fileManager.contentsOfDirectory(atPath: url.path).filter(isRecordName).sorted()
  }

  func remove(_ name: String) throws {
    guard isRecordName(name) else { throw DurableFileFailure.invalid("The record name isn't valid.") }
    try unlinkDurably(name)
  }

  func removeLeftover(_ fileName: String) throws {
    guard isTemporaryName(fileName) else { throw DurableFileFailure.invalid("Only a leftover temporary file can be removed this way.") }
    try unlinkDurably(fileName)
  }

  /// Every file that isn't a record, and every record that can't be read. Deletes nothing. A phone that hasn't been
  /// unlocked since it started can't read any record, so the whole call fails then instead of calling them unreadable.
  func recover() throws -> [String: [String]] {
    var leftovers: [String] = []
    var unreadable: [String] = []
    if exists() {
      for name in try fileManager.contentsOfDirectory(atPath: url.path).sorted() {
        guard isRecordName(name) else {
          leftovers.append(name)
          continue
        }
        do {
          _ = try readRecord(url.appendingPathComponent(name))
        } catch DurableFileFailure.locked {
          throw DurableFileFailure.locked
        } catch {
          unreadable.append(name)
        }
      }
    }
    return ["leftovers": leftovers, "unreadable": unreadable]
  }

  private func exists() -> Bool {
    var isDirectory: ObjCBool = false
    return fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
  }

  /// Creates any missing folder, sets the outbox folder's protection and backup exclusion, then syncs Library, which
  /// holds Application Support's entry, and Application Support, which holds the outbox folder's. The syncs run once
  /// each run whether or not this run created the folders: an earlier run may have died, or failed, between a mkdir
  /// and its sync. `ready` is set only after every step succeeds, so a failure is retried by the next call.
  private func prepareFolder() throws {
    if ready && exists() { return }
    ready = false
    if !fileManager.fileExists(atPath: support.path) {
      try fileManager.createDirectory(at: support, withIntermediateDirectories: true)
    }
    if !exists() {
      try fileManager.createDirectory(at: url, withIntermediateDirectories: false, attributes: protection)
    }
    try protect(url)
    try syncDirectory(support.deletingLastPathComponent())
    try syncDirectory(support)
    ready = true
  }

  private func protect(_ item: URL) throws {
    try fileManager.setAttributes(protection, ofItemAtPath: item.path)
    var excluded = item
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }

  private func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let base = buffer.baseAddress else { return }
      var offset = 0
      while offset < buffer.count {
        let written = Darwin.write(fd, base + offset, buffer.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          throw DurableFileFailure.failed(posix("write the temporary file"))
        }
        offset += written
      }
    }
  }

  /// The record's text, or nil when there's no record. Throws `unreadable` for a file that isn't a whole record of
  /// valid UTF-8 within the size bound, and `locked` while data protection keeps it closed.
  private func readRecord(_ file: URL) throws -> String? {
    let fd = Darwin.open(file.path, O_RDONLY | O_CLOEXEC)
    if fd < 0 {
      if errno == ENOENT { return nil }
      if errno == EPERM || errno == EACCES { throw DurableFileFailure.locked }
      throw DurableFileFailure.unreadable(posix("open the record"))
    }
    defer { _ = Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw DurableFileFailure.unreadable(posix("read the record's size")) }
    guard (info.st_mode & S_IFMT) == S_IFREG else { throw DurableFileFailure.unreadable("The record isn't a file.") }
    guard info.st_size <= Int64(recordMaxBytes) else { throw DurableFileFailure.unreadable("The record is larger than \(recordMaxBytes) bytes.") }
    let size = Int(info.st_size)
    var data = Data(count: size)
    if size > 0 {
      try data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) in
        guard let base = buffer.baseAddress else { return }
        var offset = 0
        while offset < size {
          let count = Darwin.read(fd, base + offset, size - offset)
          if count < 0 {
            if errno == EINTR { continue }
            if errno == EPERM || errno == EACCES { throw DurableFileFailure.locked }
            throw DurableFileFailure.unreadable(posix("read the record"))
          }
          if count == 0 { throw DurableFileFailure.unreadable("The record ended early.") }
          offset += count
        }
      }
    }
    guard let text = String(data: data, encoding: .utf8) else { throw DurableFileFailure.unreadable("The record isn't valid UTF-8.") }
    return text
  }

  private func unlinkDurably(_ fileName: String) throws {
    guard exists() else { return }
    if Darwin.unlink(url.appendingPathComponent(fileName).path) != 0 && errno != ENOENT {
      throw DurableFileFailure.failed(posix("delete the file"))
    }
    try syncAfterChange()
  }

  /// Syncs the folder after a rename or delete in it. A failure then is `unsynced`: the change may stand.
  private func syncAfterChange() throws {
    do {
      try syncDirectory(url)
    } catch DurableFileFailure.failed(let why) {
      throw DurableFileFailure.unsynced(why)
    }
  }

  /// Flushes the folder's entries, so a rename or delete in it survives power loss. F_FULLFSYNC also flushes the
  /// drive's cache. Only when the file system refuses F_FULLFSYNC as unsupported, with ENOTSUP or ENOTTY (how XNU
  /// file systems refuse an fcntl they don't implement), does plain fsync stand in. Any other error, EIO included,
  /// means the flush failed, and throws.
  private func syncDirectory(_ directory: URL) throws {
    let fd = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { throw DurableFileFailure.failed(posix("open the folder")) }
    defer { _ = Darwin.close(fd) }
    if Darwin.fcntl(fd, F_FULLFSYNC) != -1 { return }
    guard errno == ENOTSUP || errno == ENOTTY else { throw DurableFileFailure.failed(posix("flush the folder")) }
    guard fsync(fd) == 0 else { throw DurableFileFailure.failed(posix("sync the folder")) }
  }
}
