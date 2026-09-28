package com.kreos.ftp.protocol

import com.kreos.ftp.model.Protocol
import com.kreos.ftp.model.RemoteEntry
import com.kreos.ftp.model.SiteProfile
import org.apache.commons.net.ftp.FTP
import org.apache.commons.net.ftp.FTPClient
import org.apache.commons.net.ftp.FTPSClient
import org.apache.commons.net.util.TrustManagerUtils
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream

class FtpRemoteClient(private val profile: SiteProfile) : RemoteClient {
    private val client: FTPClient = if (profile.protocol == Protocol.FTPS) FTPSClient(false) else FTPClient()

    override fun connect() {
        client.connectTimeout = 15_000
        client.defaultTimeout = 20_000
        client.controlKeepAliveTimeout = 20
        if (client is FTPSClient) {
            client.trustManager = TrustManagerUtils.getValidateServerCertificateTrustManager()
            client.isEndpointCheckingEnabled = true
        }
        client.connect(profile.host, profile.port)
        check(client.login(profile.username, profile.password)) { "Сервер отклонил логин или пароль" }
        if (client is FTPSClient) {
            client.execPBSZ(0)
            client.execPROT("P")
        }
        client.enterLocalPassiveMode()
        client.setFileType(FTP.BINARY_FILE_TYPE)
        client.bufferSize = 64 * 1024
        client.controlEncoding = "UTF-8"
    }

    override fun list(path: String): List<RemoteEntry> = client.listFiles(RemotePath.normalize(path))
        .asSequence()
        .filter { it.name != "." && it.name != ".." }
        .map { file ->
            require(!file.name.contains('/') && !file.name.contains('\\') && !file.name.contains('\u0000')) {
                "Сервер вернул небезопасное имя"
            }
            RemoteEntry(
                name = file.name,
                path = RemotePath.join(path, file.name),
                directory = file.isDirectory,
                size = if (file.isFile) file.size else 0,
                modifiedAt = file.timestamp?.timeInMillis
            )
        }
        .sortedWith(compareByDescending<RemoteEntry> { it.directory }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
        .toList()

    override fun makeDirectories(path: String) {
        var current = ""
        RemotePath.normalize(path).trim('/').split('/').filter(String::isNotEmpty).forEach { part ->
            current += "/$part"
            if (!client.changeWorkingDirectory(current)) {
                check(client.makeDirectory(current) || client.changeWorkingDirectory(current)) {
                    "Не удалось создать $current: ${client.replyString.trim()}"
                }
            }
        }
        client.changeWorkingDirectory("/")
    }

    override fun upload(input: InputStream, size: Long, remotePath: String, progress: (Long) -> Unit) {
        val target = RemotePath.normalize(remotePath)
        makeDirectories(RemotePath.parent(target))
        val output = client.storeFileStream(target) ?: error("Не удалось открыть $target: ${client.replyString.trim()}")
        output.use { copy(input, it, progress) }
        check(client.completePendingCommand()) { "Сервер не подтвердил загрузку $target" }
    }

    override fun download(remotePath: String, output: OutputStream, progress: (Long) -> Unit) {
        val input = client.retrieveFileStream(RemotePath.normalize(remotePath))
            ?: error("Не удалось открыть $remotePath: ${client.replyString.trim()}")
        input.use { copy(it, output, progress) }
        check(client.completePendingCommand()) { "Сервер не подтвердил скачивание $remotePath" }
    }

    override fun delete(path: String, directory: Boolean) {
        val ok = if (directory) client.removeDirectory(path) else client.deleteFile(path)
        check(ok) { "Не удалось удалить $path: ${client.replyString.trim()}" }
    }

    override fun rename(from: String, to: String) {
        check(client.rename(from, to)) { "Не удалось переименовать: ${client.replyString.trim()}" }
    }

    override fun readSmallFile(path: String, limit: Int): ByteArray {
        val buffer = LimitedOutputStream(limit)
        download(path, buffer) {}
        return buffer.toByteArray()
    }

    override fun close() {
        runCatching { if (client.isConnected) client.logout() }
        runCatching { if (client.isConnected) client.disconnect() }
    }

    private fun copy(input: InputStream, output: OutputStream, progress: (Long) -> Unit) {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            total += count
            progress(total)
        }
        output.flush()
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
