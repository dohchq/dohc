package app.dohc.durablefile

import android.system.Os
import android.system.OsConstants
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/** Prepares the folder under `noBackupFilesDir`, which Android never backs up, that holds kept.db, and returns its
 * path. It creates the folder and kept.db if missing, then syncs each folder whose entries changed, so the file
 * survives power loss before SQLite's first commit. */
class DurableFileModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DurableFile")
    AsyncFunction("prepareFolder") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val parent = context.noBackupFilesDir
      val folder = File(parent, "dohc-kept")
      try {
        if (!folder.isDirectory && !folder.mkdirs()) throw IllegalStateException("mkdir failed")
        File(folder, "kept.db").createNewFile()
        for (directory in listOfNotNull(parent.parentFile, parent, folder)) syncDirectory(directory)
      } catch (error: Exception) {
        throw CodedException("ERR_DURABLE_FAILED", "Couldn't prepare the folder: ${error.message}", error)
      }
      folder.path
    }
  }
}

/** Java's File API can't sync a folder, so this goes through `android.system.Os`. */
private fun syncDirectory(directory: File) {
  val fd = Os.open(directory.path, OsConstants.O_RDONLY, 0)
  try {
    Os.fsync(fd)
  } finally {
    Os.close(fd)
  }
}
