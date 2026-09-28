package com.kreos.ftp.protocol

import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.Session
import com.jcraft.jsch.SftpProgressMonitor
import com.kreos.ftp.model.RemoteEntry
import com.kreos.ftp.model.SiteProfile
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.Vector

class SftpRemoteClient(private val profile: SiteProfile) : RemoteClient {
    private var session: Session? = null
    private var channel: ChannelSftp? = null

    override fun connect() {
        val nextSession = SshSessionFactory.connect(profile, profile.port)
        session = nextSession
        channel = (nextSession.openChannel("sftp") as ChannelSftp).apply { connect(15_000) }
    }

    override fun list(path: String): List<RemoteEntry> {
        @Suppress("UNCHECKED_CAST")
        val entries = need().ls(RemotePath.normalize(path)) as Vector<ChannelSftp.LsEntry>
        return entries.asSequence()
            .filter { it.filename != "." && it.filename != ".." }
            .map { entry ->
                val name = entry.filename
                require(!name.contains('/') && !name.contains('\\') && !name.contains('\u0000')) {
                    "Сервер вернул небезопасное имя"
                }
                RemoteEntry(
                    name = name,
                    path = RemotePath.join(path, name),
                    directory = entry.attrs.isDir,
                    size = if (entry.attrs.isDir) 0 else entry.attrs.size,
                    modifiedAt = entry.attrs.mTime.toLong() * 1000
                )
            }
            .sortedWith(compareByDescending<RemoteEntry> { it.directory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
            .toList()
    }

    override fun makeDirectories(path: String) {
        var current = ""
        RemotePath.normalize(path).trim('/').split('/').filter(String::isNotEmpty).forEach { part ->
            current += "/$part"
            val exists = runCatching { need().stat(current).isDir }.getOrDefault(false)
            if (!exists) need().mkdir(current)
        }
    }

    override fun upload(input: InputStream, size: Long, remotePath: String, progress: (Long) -> Unit) {
        val target = RemotePath.normalize(remotePath)
        makeDirectories(RemotePath.parent(target))
        need().put(input, target, monitor(size, progress), ChannelSftp.OVERWRITE)
    }

    override fun download(remotePath: String, output: OutputStream, progress: (Long) -> Unit) {
        need().get(RemotePath.normalize(remotePath), output, monitor(-1, progress), ChannelSftp.OVERWRITE, 0)
    }

    override fun delete(path: String, directory: Boolean) {
        if (directory) need().rmdir(path) else need().rm(path)
    }

    override fun rename(from: String, to: String) = need().rename(from, to)

    override fun readSmallFile(path: String, limit: Int): ByteArray {
        val output = LimitedOutputStream(limit)
        download(path, output) {}
        return output.toByteArray()
    }

    override fun close() {
        runCatching { channel?.disconnect() }
        runCatching { session?.disconnect() }
        channel = null
        session = null
    }

    private fun need(): ChannelSftp = channel?.takeIf { it.isConnected } ?: error("SFTP не подключён")

    private fun monitor(total: Long, progress: (Long) -> Unit): SftpProgressMonitor =
        object : SftpProgressMonitor {
            private var transferred = 0L
            override fun init(op: Int, src: String?, dest: String?, max: Long) = Unit
            override fun count(count: Long): Boolean {
                transferred += count
                progress(transferred)
                return !Thread.currentThread().isInterrupted
            }
            override fun end() = Unit
        }

    private class LimitedOutputStream(private val limit: Int) : OutputStream() {
        private val delegate = ByteArrayOutputStream()
        override fun write(value: Int) {
            check(delegate.size() < limit) { "Файл больше $limit байт" }
            delegate.write(value)
        }
        override fun write(value: ByteArray, offset: Int, length: Int) {
            check(delegate.size() + length <= limit) { "Файл больше $limit байт" }
            delegate.write(value, offset, length)
        }
        fun toByteArray(): ByteArray = delegate.toByteArray()
    }
}
