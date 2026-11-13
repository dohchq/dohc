package app.dohc.durablefile

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.UUID

/** The largest record, in UTF-8 bytes. The binding checks the same number. */
private const val RECORD_MAX_BYTES = 512 * 1024
private const val FOLDER_NAME = "dohc-outbox"

/** Letters, digits, "-" and "_", 1 to 100 of them. */
private val RECORD_NAME = Regex("[A-Za-z0-9_-]{1,100}")
private val TEMPORARY_NAME = Regex("[A-Za-z0-9_-]{1,100}\\.[0-9a-f]{32}\\.tmp")

/** The binding reads what went wrong from the code. */
internal class DurableFileException(code: String, message: String, cause: Throwable? = null) :
  CodedException(code, message, cause)

private fun invalid(message: String) = DurableFileException("ERR_DURABLE_INVALID", message)
private fun failed(step: String, cause: Throwable) =
  DurableFileException("ERR_DURABLE_FAILED", "Couldn't $step: ${cause.message}", cause)
private fun unreadable(cause: Throwable) =
  DurableFileException("ERR_DURABLE_UNREADABLE", "Couldn't read the record: ${cause.message}", cause)

/** Keeps the outbox's records in a folder under `noBackupFilesDir`, which Android never backs up. A write resolves only
 * once its record is on disk through a closed app, a restart and power loss. Expo runs a module's async functions on
 * one thread, so calls run one at a time, in the order JavaScript made them. */
class DurableFileModule : Module() {
  private val folder by lazy {
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    DurableFolder(File(context.noBackupFilesDir, FOLDER_NAME))
  }

  override fun definition() = ModuleDefinition {
    Name("DurableFile")
    AsyncFunction("write") { name: String, text: String -> folder.write(name, text) }
    AsyncFunction("read") { name: String -> folder.read(name) }
    AsyncFunction("list") { folder.list() }
    AsyncFunction("remove") { name: String -> folder.remove(name) }
    AsyncFunction("recover") { folder.recover() }
    AsyncFunction("removeLeftover") { fileName: String -> folder.removeLeftover(fileName) }
  }
}

internal class DurableFolder(private val dir: File) {
  fun write(name: String, text: String) {
    if (!RECORD_NAME.matches(name)) throw invalid("The record name isn't valid.")
    val bytes = encode(text)
    if (bytes.size > RECORD_MAX_BYTES) {
      throw DurableFileException("ERR_DURABLE_TOO_LARGE", "The record is larger than $RECORD_MAX_BYTES bytes.")
    }
    prepareFolder()
    val temp = File(dir, "$name.${UUID.randomUUID().toString().replace("-", "")}.tmp")
    try {
      if (!temp.createNewFile()) throw IOException("the temporary file already exists")
      FileOutputStream(temp).use { stream ->
        stream.write(bytes)
        stream.fd.sync()
      }
      Os.rename(temp.path, File(dir, name).path)
    } catch (error: Exception) {
      temp.delete()
      throw failed("write the record", error)
    }
    syncAfterChange()
  }

  fun read(name: String): String? {
    if (!RECORD_NAME.matches(name)) throw invalid("The record name isn't valid.")
    val file = File(dir, name)
    return if (file.exists()) readRecord(file) else null
  }

  fun list(): List<String> = entries().filter { RECORD_NAME.matches(it) }

  fun remove(name: String) {
    if (!RECORD_NAME.matches(name)) throw invalid("The record name isn't valid.")
    unlinkDurably(name)
  }

  fun removeLeftover(fileName: String) {
    if (!TEMPORARY_NAME.matches(fileName)) throw invalid("Only a leftover temporary file can be removed this way.")
    unlinkDurably(fileName)
  }

  /** Every file that isn't a record, and every record that can't be read. Deletes nothing. */
  fun recover(): Map<String, List<String>> {
    val leftovers = mutableListOf<String>()
    val unreadable = mutableListOf<String>()
    for (name in entries()) {
      if (!RECORD_NAME.matches(name)) {
        leftovers.add(name)
        continue
      }
      try {
        readRecord(File(dir, name))
      } catch (error: DurableFileException) {
        unreadable.add(name)
      }
    }
    return mapOf("leftovers" to leftovers, "unreadable" to unreadable)
  }

  private fun entries(): List<String> {
    if (!dir.isDirectory) return emptyList()
    val names = dir.list() ?: throw failed("list the folder", IOException("the folder couldn't be listed"))
    return names.sorted()
  }

  /** Creates the folder and syncs the folder that holds it, so the new entry survives power loss. */
  private fun prepareFolder() {
    if (dir.isDirectory) return
    try {
      val parent = dir.parentFile ?: throw IOException("the folder has no parent")
      if (!parent.isDirectory && !parent.mkdirs()) throw IOException("its parent couldn't be created")
      if (!dir.mkdir() && !dir.isDirectory) throw IOException("mkdir failed")
      syncDirectory(parent)
    } catch (error: Exception) {
      throw failed("create the folder", error)
    }
  }

  /** A file that isn't a whole record of valid UTF-8 within the size bound is unreadable. */
  private fun readRecord(file: File): String {
    try {
      if (!file.isFile) throw IOException("it isn't a file")
      if (file.length() > RECORD_MAX_BYTES) throw IOException("it's larger than $RECORD_MAX_BYTES bytes")
      val bytes = file.readBytes()
      if (bytes.size > RECORD_MAX_BYTES) throw IOException("it's larger than $RECORD_MAX_BYTES bytes")
      return Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    } catch (error: Exception) {
      throw unreadable(error)
    }
  }

  private fun unlinkDurably(fileName: String) {
    if (!dir.isDirectory) return
    try {
      Os.remove(File(dir, fileName).path)
    } catch (error: ErrnoException) {
      if (error.errno != OsConstants.ENOENT) throw failed("delete the file", error)
    }
    syncAfterChange()
  }

  /** Syncs the folder after a rename or delete in it. A failure then is unsynced: the change may stand. */
  private fun syncAfterChange() {
    try {
      syncDirectory(dir)
    } catch (error: Exception) {
      throw DurableFileException("ERR_DURABLE_UNSYNCED", "Couldn't sync the folder: ${error.message}", error)
    }
  }

  /** Opens the folder and fsyncs it. Java's File API can't sync a folder, so this goes through `android.system.Os`. */
  private fun syncDirectory(directory: File) {
    val fd = Os.open(directory.path, OsConstants.O_RDONLY, 0)
    try {
      Os.fsync(fd)
    } finally {
      Os.close(fd)
    }
  }
}

/** UTF-8, refusing text with a lone surrogate, which a plain conversion would turn into "?" without a word. */
private fun encode(text: String): ByteArray {
  val buffer = try {
    Charsets.UTF_8.newEncoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .encode(CharBuffer.wrap(text))
  } catch (error: CharacterCodingException) {
    throw invalid("The record's text isn't valid Unicode.")
  }
  return ByteArray(buffer.remaining()).also { buffer.get(it) }
}
