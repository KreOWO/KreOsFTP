package com.kreos.ftp.transfer

import android.content.ContentResolver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.documentfile.provider.DocumentFile
import com.kreos.ftp.model.SiteProfile
import com.kreos.ftp.model.SyncAction
import com.kreos.ftp.model.TransferState
import com.kreos.ftp.protocol.RemoteClient
import com.kreos.ftp.protocol.RemoteClientFactory
import com.kreos.ftp.protocol.RemotePath
import com.kreos.ftp.sync.DocumentTrees
import com.kreos.ftp.sync.SyncPlanner
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class TransferEngine(
    private val resolver: ContentResolver,
    private val onChanged: (List<TransferState>) -> Unit
) : Closeable {
    private val executor = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    private val states = ConcurrentHashMap<String, TransferState>()

    fun upload(profile: SiteProfile, source: DocumentFile, remoteDirectory: String) {
        submit("↑ ${source.name ?: "файл"}", profile) { id, client ->
            uploadTree(id, client, source, remoteDirectory)
        }
    }

    fun download(profile: SiteProfile, remotePath: String, directory: Boolean, size: Long, local: DocumentFile) {
        submit("↓ ${remotePath.substringAfterLast('/')}", profile) { id, client ->
            if (directory) downloadTree(id, client, remotePath, local)
            else downloadFile(id, client, remotePath, size, local, remotePath.substringAfterLast('/'))
        }
    }

    fun sync(
        profile: SiteProfile,
        localRoot: DocumentFile,
        remoteRoot: String,
        upload: Boolean,
        onComplete: (String) -> Unit
    ) {
        val label = if (upload) "Подготовка обновления сервера" else "Подготовка локальной версии"
        val preparationId = UUID.randomUUID().toString()
        states[preparationId] = TransferState(label, 0, null)
        publish()
        executor.execute {
            try {
                RemoteClientFactory.create(profile).use { client ->
                    client.connect()
                    val plan = if (upload) SyncPlanner(resolver).upload(localRoot, client, remoteRoot)
                    else SyncPlanner(resolver).download(localRoot, client, remoteRoot)
                    if (upload) {
                        plan.directories.forEach { client.makeDirectories(joinRelative(remoteRoot, it)) }
                    } else {
                        plan.directories.forEach { DocumentTrees.ensureDirectory(localRoot, it) }
                    }
                    states.remove(preparationId)
                    publish()
                    plan.actions.forEach { action ->
                        val id = UUID.randomUUID().toString()
                        val actionLabel = if (action is SyncAction.Upload) "↑ ${action.relativePath}" else "↓ ${action.relativePath}"
                        states[id] = TransferState(actionLabel, 0, action.size)
                        publish()
                        when (action) {
                            is SyncAction.Upload -> {
                                val input = resolver.openInputStream(Uri.parse(action.localUri))
                                    ?: error("Не удалось открыть ${action.relativePath}")
                                input.use { client.upload(it, action.size, action.remotePath) { done -> update(id, done) } }
                            }
                            is SyncAction.Download -> {
                                val target = DocumentTrees.ensureFile(localRoot, action.relativePath)
                                val output = resolver.openOutputStream(target.uri, "rwt")
                                    ?: error("Не удалось записать ${action.relativePath}")
                                output.use { client.download(action.remotePath, it) { done -> update(id, done) } }
                            }
                        }
                        finish(id)
                    }
                    main.post {
                        onComplete(
                            "Готово: ${plan.actions.size}; без изменений: ${plan.unchanged}; исключено: ${plan.ignored}"
                        )
                    }
                }
            } catch (error: Exception) {
                states[preparationId] = TransferState(label, 0, null, finished = true, error = error.message)
                publish()
                main.post { onComplete("Ошибка: ${error.message}") }
            }
        }
    }

    private fun submit(label: String, profile: SiteProfile? = null, action: (String, RemoteClient) -> Unit) {
        requireNotNull(profile) { "Профиль подключения не указан" }
        val id = UUID.randomUUID().toString()
        states[id] = TransferState(label, 0, null)
        publish()
        executor.execute {
            try {
                RemoteClientFactory.create(profile).use { client ->
                    client.connect()
                    action(id, client)
                }
                finish(id)
            } catch (error: Exception) {
                states[id] = states.getValue(id).copy(finished = true, error = error.message)
                publish()
            }
        }
    }

    private fun uploadTree(id: String, client: RemoteClient, source: DocumentFile, remoteDirectory: String) {
        val name = source.name ?: error("Файл без имени")
        if (source.isDirectory) {
            val target = RemotePath.join(remoteDirectory, name)
            client.makeDirectories(target)
            source.listFiles().forEach { uploadTree(id, client, it, target) }
        } else {
            val input = resolver.openInputStream(source.uri) ?: error("Не удалось открыть $name")
            input.use { client.upload(it, source.length(), RemotePath.join(remoteDirectory, name)) { done -> update(id, done, source.length()) } }
        }
    }

    private fun downloadTree(id: String, client: RemoteClient, remotePath: String, localDirectory: DocumentFile) {
        val folder = DocumentTrees.ensureDirectory(localDirectory, remotePath.substringAfterLast('/'))
        client.list(remotePath).forEach { entry ->
            if (entry.directory) downloadTree(id, client, entry.path, folder)
            else downloadFile(id, client, entry.path, entry.size, folder, entry.name)
        }
    }

    private fun downloadFile(
        id: String,
        client: RemoteClient,
        remotePath: String,
        size: Long,
        localDirectory: DocumentFile,
        name: String
    ) {
        val target = DocumentTrees.ensureFile(localDirectory, name)
        val output = resolver.openOutputStream(target.uri, "rwt") ?: error("Не удалось записать $name")
        output.use { client.download(remotePath, it) { done -> update(id, done, size) } }
    }

    private fun update(id: String, transferred: Long, total: Long? = states[id]?.total) {
        states.computeIfPresent(id) { _, old -> old.copy(transferred = transferred, total = total) }
        publish()
    }

    private fun finish(id: String) {
        states.computeIfPresent(id) { _, old -> old.copy(finished = true, transferred = old.total ?: old.transferred) }
        publish()
    }

    private fun publish() {
        val snapshot = states.values.sortedWith(compareBy<TransferState> { it.finished }.thenBy { it.label })
        main.post { onChanged(snapshot) }
    }

    private fun joinRelative(root: String, relative: String): String =
        relative.split('/').fold(RemotePath.normalize(root), RemotePath::join)

    override fun close() {
        executor.shutdownNow()
    }
}
