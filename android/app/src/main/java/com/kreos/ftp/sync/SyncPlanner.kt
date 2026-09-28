package com.kreos.ftp.sync

import android.content.ContentResolver
import androidx.documentfile.provider.DocumentFile
import com.kreos.ftp.model.RemoteEntry
import com.kreos.ftp.model.SyncAction
import com.kreos.ftp.model.SyncPlan
import com.kreos.ftp.protocol.RemoteClient
import com.kreos.ftp.protocol.RemotePath

class SyncPlanner(private val resolver: ContentResolver) {
    private data class LocalFile(val relative: String, val uri: String, val size: Long)
    private data class RemoteFile(val relative: String, val path: String, val size: Long)
    private data class Tree<T>(val files: List<T>, val directories: List<String>, val ignored: Int)

    fun upload(localRoot: DocumentFile, remote: RemoteClient, remoteRoot: String): SyncPlan {
        val ignore = localIgnore(localRoot)
        val local = walkLocal(localRoot, ignore)
        val server = walkRemote(remote, remoteRoot, ignore)
        val serverFiles = server.files.associateBy { it.relative }
        val serverDirectories = server.directories.toSet()
        var unchanged = 0
        val actions = local.files.mapNotNull { source ->
            val target = serverFiles[source.relative]
            if (target?.size == source.size) {
                unchanged++
                null
            } else SyncAction.Upload(
                relativePath = source.relative,
                localUri = source.uri,
                remotePath = remoteJoinRelative(remoteRoot, source.relative),
                size = source.size
            )
        }
        return SyncPlan(
            actions = actions,
            directories = local.directories.filterNot(serverDirectories::contains),
            ignored = local.ignored,
            unchanged = unchanged
        )
    }

    fun download(localRoot: DocumentFile, remote: RemoteClient, remoteRoot: String): SyncPlan {
        val rootEntries = remote.list(remoteRoot)
        val control = rootEntries.firstOrNull { it.name == ".ftpignore" && !it.directory }
        val ignore = FtpIgnore(control?.let { remote.readSmallFile(it.path).toString(Charsets.UTF_8) }.orEmpty())
        val server = walkRemote(remote, remoteRoot, ignore, rootEntries)
        val local = walkLocal(localRoot, ignore)
        val localFiles = local.files.associateBy { it.relative }
        val localDirectories = local.directories.toSet()
        var unchanged = 0
        val actions = server.files.mapNotNull { source ->
            val target = localFiles[source.relative]
            if (target?.size == source.size) {
                unchanged++
                null
            } else SyncAction.Download(source.relative, source.path, source.size)
        }
        return SyncPlan(
            actions = actions,
            directories = server.directories.filterNot(localDirectories::contains),
            ignored = server.ignored,
            unchanged = unchanged
        )
    }

    private fun localIgnore(root: DocumentFile): FtpIgnore {
        val control = DocumentTrees.child(root, ".ftpignore")
        return FtpIgnore(control?.takeIf(DocumentFile::isFile)?.let { DocumentTrees.readText(resolver, it) }.orEmpty())
    }

    private fun walkLocal(root: DocumentFile, ignore: FtpIgnore): Tree<LocalFile> {
        val files = mutableListOf<LocalFile>()
        val directories = mutableListOf<String>()
        var ignored = 0
        var visited = 0
        fun visit(directory: DocumentFile, prefix: String, depth: Int) {
            check(depth <= 64) { "Слишком глубокое локальное дерево" }
            directory.listFiles().sortedBy { it.name?.lowercase() }.forEach { item ->
                check(++visited <= 100_000) { "Синхронизация ограничена 100 000 объектов" }
                val name = item.name ?: return@forEach
                if (name.contains('/') || name.contains('\\') || name.contains('\u0000')) return@forEach
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"
                if (ignore.ignores(relative, item.isDirectory)) {
                    ignored++
                } else if (item.isDirectory) {
                    directories += relative
                    visit(item, relative, depth + 1)
                } else if (item.isFile) {
                    files += LocalFile(relative, item.uri.toString(), item.length())
                }
            }
        }
        visit(root, "", 0)
        return Tree(files, directories, ignored)
    }

    private fun walkRemote(
        client: RemoteClient,
        root: String,
        ignore: FtpIgnore,
        firstLevel: List<RemoteEntry>? = null
    ): Tree<RemoteFile> {
        val files = mutableListOf<RemoteFile>()
        val directories = mutableListOf<String>()
        var ignored = 0
        var visited = 0
        fun visit(path: String, prefix: String, depth: Int, supplied: List<RemoteEntry>? = null) {
            check(depth <= 64) { "Слишком глубокое серверное дерево" }
            (supplied ?: client.list(path)).forEach { item ->
                check(++visited <= 100_000) { "Синхронизация ограничена 100 000 объектов" }
                val relative = if (prefix.isEmpty()) item.name else "$prefix/${item.name}"
                if (ignore.ignores(relative, item.directory)) {
                    ignored++
                } else if (item.directory) {
                    directories += relative
                    visit(item.path, relative, depth + 1)
                } else {
                    files += RemoteFile(relative, item.path, item.size)
                }
            }
        }
        visit(RemotePath.normalize(root), "", 0, firstLevel)
        return Tree(files, directories, ignored)
    }

    private fun remoteJoinRelative(root: String, relative: String): String =
        relative.split('/').fold(RemotePath.normalize(root), RemotePath::join)
}
