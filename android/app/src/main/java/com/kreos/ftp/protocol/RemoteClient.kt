package com.kreos.ftp.protocol

import com.kreos.ftp.model.RemoteEntry
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream

interface RemoteClient : Closeable {
    fun connect()
    fun list(path: String): List<RemoteEntry>
    fun makeDirectories(path: String)
    fun upload(input: InputStream, size: Long, remotePath: String, progress: (Long) -> Unit)
    fun download(remotePath: String, output: OutputStream, progress: (Long) -> Unit)
    fun delete(path: String, directory: Boolean)
    fun rename(from: String, to: String)
    fun readSmallFile(path: String, limit: Int = 1024 * 1024): ByteArray
}

class HostKeyApprovalRequired(val fingerprint: String) : Exception(
    "Подтвердите ключ сервера $fingerprint"
)

class HostKeyMismatch(expected: String, actual: String) : Exception(
    "Ключ сервера изменился. Ожидался $expected, получен $actual"
)

object RemotePath {
    fun normalize(path: String): String {
        val parts = ArrayDeque<String>()
        path.replace('\\', '/').split('/').forEach { part ->
            when (part) {
                "", "." -> Unit
                ".." -> if (parts.isNotEmpty()) parts.removeLast()
                else -> {
                    require(!part.contains('\u0000')) { "Недопустимый путь" }
                    parts.addLast(part)
                }
            }
        }
        return "/" + parts.joinToString("/")
    }

    fun join(parent: String, child: String): String {
        require(child.isNotBlank() && child != "." && child != "..") { "Недопустимое имя" }
        require(!child.contains('/') && !child.contains('\\') && !child.contains('\u0000')) {
            "Недопустимое имя"
        }
        return normalize("${normalize(parent)}/$child")
    }

    fun parent(path: String): String {
        val normalized = normalize(path)
        if (normalized == "/") return "/"
        return normalized.substringBeforeLast('/').ifBlank { "/" }
    }
}
