package com.kreos.ftp.terminal

import com.jcraft.jsch.ChannelShell
import com.jcraft.jsch.Session
import com.kreos.ftp.model.SiteProfile
import com.kreos.ftp.protocol.HostKeyApprovalRequired
import com.kreos.ftp.protocol.SshSessionFactory
import java.io.Closeable
import java.io.OutputStream
import java.io.InputStreamReader
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class SshTerminalSession(
    private val profile: SiteProfile,
    private val listener: Listener
) : Closeable {
    interface Listener {
        fun onConnected()
        fun onText(text: String)
        fun onHostKeyRequired(fingerprint: String)
        fun onClosed(message: String)
    }

    private val reader = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "kreos-ssh-reader").apply { isDaemon = true }
    }
    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "kreos-ssh-writer").apply { isDaemon = true }
    }
    private val closed = AtomicBoolean(false)
    @Volatile private var session: Session? = null
    @Volatile private var channel: ChannelShell? = null
    @Volatile private var output: OutputStream? = null

    fun connect(columns: Int, rows: Int, pixelWidth: Int, pixelHeight: Int) {
        reader.execute {
            try {
                val nextSession = SshSessionFactory.connect(profile, profile.sshPort)
                if (closed.get()) {
                    nextSession.disconnect()
                    return@execute
                }
                session = nextSession
                val shell = nextSession.openChannel("shell") as ChannelShell
                shell.setPty(true)
                shell.setPtyType(
                    "xterm-256color",
                    columns.coerceAtLeast(2),
                    rows.coerceAtLeast(2),
                    pixelWidth.coerceAtLeast(1),
                    pixelHeight.coerceAtLeast(1)
                )
                shell.setEnv("TERM", "xterm-256color")
                val input = shell.inputStream
                output = shell.outputStream
                channel = shell
                shell.connect(15_000)
                listener.onConnected()
                InputStreamReader(input, Charsets.UTF_8).use { stream ->
                    val buffer = CharArray(4096)
                    while (!closed.get()) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        if (count > 0) listener.onText(String(buffer, 0, count))
                    }
                }
                if (!closed.get()) listener.onClosed("SSH-сессия завершена (код ${shell.exitStatus})")
            } catch (approval: HostKeyApprovalRequired) {
                if (!closed.get()) listener.onHostKeyRequired(approval.fingerprint)
            } catch (error: Exception) {
                if (!closed.get()) listener.onClosed("Ошибка SSH: ${error.message ?: error.javaClass.simpleName}")
            } finally {
                disconnectTransport()
            }
        }
    }

    fun send(text: String) {
        if (text.isEmpty() || closed.get()) return
        enqueueWrite {
            val bytes = text.toByteArray(Charsets.UTF_8)
            output?.run {
                write(bytes)
                flush()
            }
            bytes.fill(0)
        }
    }

    fun resize(columns: Int, rows: Int, pixelWidth: Int, pixelHeight: Int) {
        if (closed.get()) return
        enqueueWrite {
            channel?.setPtySize(
                columns.coerceAtLeast(2),
                rows.coerceAtLeast(2),
                pixelWidth.coerceAtLeast(1),
                pixelHeight.coerceAtLeast(1)
            )
        }
    }

    private fun enqueueWrite(action: () -> Unit) {
        try {
            writer.execute {
                try {
                    if (!closed.get()) action()
                } catch (error: Exception) {
                    if (!closed.get()) listener.onClosed("Ошибка записи SSH: ${error.message}")
                }
            }
        } catch (_: RejectedExecutionException) {
            // The dialog was closed while an input event was being dispatched.
        }
    }

    private fun disconnectTransport() {
        runCatching { output?.close() }
        runCatching { channel?.disconnect() }
        runCatching { session?.disconnect() }
        output = null
        channel = null
        session = null
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        disconnectTransport()
        reader.shutdownNow()
        writer.shutdownNow()
    }
}
