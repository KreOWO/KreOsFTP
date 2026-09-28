package com.kreos.ftp

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.documentfile.provider.DocumentFile
import com.kreos.ftp.model.Protocol
import com.kreos.ftp.model.RemoteEntry
import com.kreos.ftp.model.SiteProfile
import com.kreos.ftp.model.TransferState
import com.kreos.ftp.protocol.HostKeyApprovalRequired
import com.kreos.ftp.protocol.RemoteClient
import com.kreos.ftp.protocol.RemoteClientFactory
import com.kreos.ftp.protocol.RemotePath
import com.kreos.ftp.storage.SecureSiteStore
import com.kreos.ftp.transfer.TransferEngine
import com.kreos.ftp.ui.FileListAdapter
import com.kreos.ftp.ui.PaneRow
import com.kreos.ftp.ui.SiteDialog
import com.kreos.ftp.terminal.TerminalDialog
import java.util.ArrayDeque
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private data class PaneViews(
        val root: LinearLayout,
        val path: TextView,
        val list: ListView,
        val up: Button,
        val refresh: Button
    )

    private object LocalParent
    private object RemoteParent

    private lateinit var store: SecureSiteStore
    private lateinit var transferEngine: TransferEngine
    private val io = Executors.newSingleThreadExecutor()
    private val localStack = ArrayDeque<DocumentFile>()

    private lateinit var profileSpinner: Spinner
    private lateinit var connectButton: Button
    private lateinit var localPane: PaneViews
    private lateinit var remotePane: PaneViews
    private lateinit var localAdapter: FileListAdapter
    private lateinit var remoteAdapter: FileListAdapter
    private lateinit var transferText: TextView
    private lateinit var busy: ProgressBar

    private var profiles: List<SiteProfile> = emptyList()
    private var selectedProfile: SiteProfile? = null
    @Volatile private var remoteClient: RemoteClient? = null
    private var localRoot: DocumentFile? = null
    private var localCurrent: DocumentFile? = null
    private var selectedLocal: DocumentFile? = null
    private var selectedRemote: RemoteEntry? = null
    private var remotePath: String = "/"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SecureSiteStore(this)
        transferEngine = TransferEngine(contentResolver, ::renderTransfers)
        buildInterface()
        restoreLocalTree()
        reloadProfiles(store.selectedId())
    }

    private fun buildInterface() {
        window.statusBarColor = Color.rgb(15, 19, 25)
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(15, 19, 25))
            setPadding(dp(8), dp(7), dp(8), dp(7))
        }
        page.addView(connectionBar(), LinearLayout.LayoutParams(-1, -2))

        val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val explorers = LinearLayout(this).apply {
            orientation = if (landscape) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            setPadding(0, dp(6), 0, dp(4))
        }
        localPane = pane("ЛОКАЛЬНО")
        remotePane = pane("СЕРВЕР")
        localAdapter = FileListAdapter(this)
        remoteAdapter = FileListAdapter(this)
        localPane.list.adapter = localAdapter
        remotePane.list.adapter = remoteAdapter
        wirePanes()

        val controls = transferControls(landscape)
        if (landscape) {
            explorers.addView(localPane.root, LinearLayout.LayoutParams(0, -1, 1f))
            explorers.addView(controls, LinearLayout.LayoutParams(dp(52), -1))
            explorers.addView(remotePane.root, LinearLayout.LayoutParams(0, -1, 1f))
        } else {
            explorers.addView(localPane.root, LinearLayout.LayoutParams(-1, 0, 1f))
            explorers.addView(controls, LinearLayout.LayoutParams(-1, dp(48)))
            explorers.addView(remotePane.root, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        page.addView(explorers, LinearLayout.LayoutParams(-1, 0, 1f))

        busy = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
        }
        page.addView(busy, LinearLayout.LayoutParams(-1, dp(3)))
        transferText = TextView(this).apply {
            text = "В работе: нет передач"
            textSize = 11f
            setTextColor(Color.rgb(140, 153, 171))
            setPadding(dp(8), dp(5), dp(8), dp(3))
            maxLines = 4
        }
        page.addView(transferText, LinearLayout.LayoutParams(-1, -2))
        setContentView(page)
    }

    private fun connectionBar(): View {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        profileSpinner = Spinner(this)
        bar.addView(profileSpinner, LinearLayout.LayoutParams(0, dp(44), 1f))
        bar.addView(button("+") { editSite(null) }, LinearLayout.LayoutParams(dp(44), dp(42)))
        bar.addView(button("✎") { selectedProfile?.let(::editSite) }, LinearLayout.LayoutParams(dp(44), dp(42)))
        connectButton = button("Подключить") { toggleConnection() }
        bar.addView(connectButton, LinearLayout.LayoutParams(-2, dp(42)))
        bar.addView(button("SSH") { openTerminal() }, LinearLayout.LayoutParams(-2, dp(42)))
        bar.addView(button("Папка") { chooseLocalTree() }, LinearLayout.LayoutParams(-2, dp(42)))
        profileSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) {
                selectedProfile = null
            }
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                selectedProfile = profiles.getOrNull(position)
                selectedProfile?.let { store.select(it.id) }
            }
        }
        return bar
    }

    private fun pane(title: String): PaneViews {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(21, 28, 37))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(7), dp(3), dp(5), dp(3))
        }
        val titleView = TextView(this).apply {
            text = title
            textSize = 10f
            setTextColor(Color.rgb(77, 171, 247))
            setPadding(0, 0, dp(7), 0)
        }
        val path = TextView(this).apply {
            text = "—"
            textSize = 11f
            maxLines = 1
            setTextColor(Color.rgb(215, 224, 234))
        }
        val up = button("↑") {}
        val refresh = button("↻") {}
        header.addView(titleView)
        header.addView(path, LinearLayout.LayoutParams(0, dp(38), 1f))
        header.addView(up, LinearLayout.LayoutParams(dp(42), dp(38)))
        header.addView(refresh, LinearLayout.LayoutParams(dp(42), dp(38)))
        root.addView(header)
        root.addView(columnHeader())
        val list = ListView(this).apply {
            dividerHeight = 1
            choiceMode = ListView.CHOICE_MODE_SINGLE
            setBackgroundColor(Color.rgb(18, 24, 32))
        }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        return PaneViews(root, path, list, up, refresh)
    }

    private fun columnHeader(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(dp(10), dp(3), dp(8), dp(3))
        setBackgroundColor(Color.rgb(25, 34, 45))
        addView(headerCell("Имя", 1f, 0))
        addView(headerCell("Размер", 0f, 76))
        addView(headerCell("Изменён", 0f, 112))
    }

    private fun headerCell(text: String, weight: Float, width: Int): TextView = TextView(this).apply {
        this.text = text
        textSize = 10f
        setTextColor(Color.rgb(140, 153, 171))
        layoutParams = LinearLayout.LayoutParams(if (weight > 0) 0 else dp(width), dp(25), weight)
    }

    private fun transferControls(landscape: Boolean): View = LinearLayout(this).apply {
        orientation = if (landscape) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        addView(button(if (landscape) "→" else "Загрузить →") { uploadSelected() })
        addView(button("⇧") { confirmSync(true) })
        addView(button("⇩") { confirmSync(false) })
        addView(button(if (landscape) "←" else "← Скачать") { downloadSelected() })
    }

    private fun wirePanes() {
        localPane.up.setOnClickListener { localUp() }
        localPane.refresh.setOnClickListener { loadLocal() }
        remotePane.up.setOnClickListener { remoteNavigate(RemotePath.parent(remotePath)) }
        remotePane.refresh.setOnClickListener { loadRemote() }
        localPane.list.setOnItemClickListener { _, _, position, _ ->
            when (val value = localAdapter.getItem(position).value) {
                LocalParent -> localUp()
                is DocumentFile -> if (value.isDirectory) {
                    localCurrent?.let(localStack::addLast)
                    localCurrent = value
                    loadLocal()
                } else {
                    selectedLocal = value
                    toast("Выбрано: ${value.name}")
                }
            }
        }
        remotePane.list.setOnItemClickListener { _, _, position, _ ->
            when (val value = remoteAdapter.getItem(position).value) {
                RemoteParent -> remoteNavigate(RemotePath.parent(remotePath))
                is RemoteEntry -> if (value.directory) remoteNavigate(value.path) else {
                    selectedRemote = value
                    toast("Выбрано: ${value.name}")
                }
            }
        }
    }

    private fun reloadProfiles(preferredId: String? = selectedProfile?.id) {
        profiles = store.list()
        profileSpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            profiles.map { "${it.name} · ${it.protocol}" }
        )
        val index = profiles.indexOfFirst { it.id == preferredId }.coerceAtLeast(0)
        if (profiles.isNotEmpty()) profileSpinner.setSelection(index)
        selectedProfile = profiles.getOrNull(index)
    }

    private fun editSite(existing: SiteProfile?) {
        SiteDialog.show(
            this,
            existing,
            onSave = {
                store.save(it)
                reloadProfiles(it.id)
            },
            onDelete = existing?.let { site ->
                { _ ->
                    if (selectedProfile?.id == site.id) disconnect()
                    store.delete(site.id)
                    reloadProfiles(null)
                }
            }
        )
    }

    private fun toggleConnection() {
        if (remoteClient != null) disconnect()
        else selectedProfile?.let { profile ->
            if (profile.protocol == Protocol.FTP) {
                AlertDialog.Builder(this)
                    .setTitle("Незашифрованное соединение")
                    .setMessage("FTP передаёт пароль и файлы без шифрования. Используйте FTPS или SFTP, если сервер поддерживает их.")
                    .setNegativeButton("Отмена", null)
                    .setPositiveButton("Продолжить") { _, _ -> connect(profile) }
                    .show()
            } else connect(profile)
        } ?: toast("Сначала добавьте подключение")
    }

    private fun openTerminal() {
        val profile = selectedProfile ?: return toast("Сначала добавьте подключение")
        TerminalDialog.show(this, profile, store) { updated ->
            reloadProfiles(updated.id)
        }
    }

    private fun connect(profile: SiteProfile) {
        setBusy(true, "Подключение к ${profile.name}…")
        io.execute {
            val next = RemoteClientFactory.create(profile)
            try {
                next.connect()
                remoteClient = next
                remotePath = RemotePath.normalize(profile.remotePath)
                runOnUiThread {
                    connectButton.text = "Отключить"
                    setBusy(false, "Подключено: ${profile.name}")
                    loadRemote()
                }
            } catch (approval: HostKeyApprovalRequired) {
                next.close()
                runOnUiThread { askHostKey(profile, approval.fingerprint) }
            } catch (error: Exception) {
                next.close()
                runOnUiThread { setBusy(false, "Ошибка подключения: ${error.message}") }
            }
        }
    }

    private fun askHostKey(profile: SiteProfile, fingerprint: String) {
        setBusy(false, "Ключ сервера не подтверждён")
        AlertDialog.Builder(this)
            .setTitle("Новый SSH-сервер")
            .setMessage("Сверьте отпечаток с администратором сервера:\n\n$fingerprint")
            .setNegativeButton("Отклонить", null)
            .setPositiveButton("Доверять") { _, _ ->
                val updated = profile.copy(hostKeyFingerprint = fingerprint)
                store.save(updated)
                reloadProfiles(updated.id)
                connect(updated)
            }
            .show()
    }

    private fun disconnect() {
        val current = remoteClient
        remoteClient = null
        io.execute { current?.close() }
        connectButton.text = "Подключить"
        remoteAdapter.rows = emptyList()
        remotePane.path.text = "Не подключено"
        selectedRemote = null
        setBusy(false, "Отключено")
    }

    private fun chooseLocalTree() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        }
        startActivityForResult(intent, REQUEST_TREE)
    }

    @Deprecated("Activity result API keeps this module free of an additional Activity dependency")
    @SuppressLint("WrongConstant") // Result flags are masked to the two flags accepted by this API.
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_TREE || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        contentResolver.takePersistableUriPermission(uri, flags)
        store.localTreeUri(uri.toString())
        setLocalRoot(uri)
    }

    private fun restoreLocalTree() {
        store.localTreeUri()?.let(Uri::parse)?.let(::setLocalRoot)
            ?: run { localPane.path.text = "Выберите локальную папку" }
    }

    private fun setLocalRoot(uri: Uri) {
        val root = DocumentFile.fromTreeUri(this, uri)
        if (root == null || !root.canRead()) {
            localPane.path.text = "Нет доступа к локальной папке"
            return
        }
        localRoot = root
        localCurrent = root
        localStack.clear()
        loadLocal()
    }

    private fun loadLocal() {
        val directory = localCurrent ?: return
        setBusy(true, "Чтение локальной папки…")
        io.execute {
            try {
                val rows = buildList {
                    if (localStack.isNotEmpty()) add(PaneRow("..", true, 0, null, LocalParent))
                    directory.listFiles()
                        .sortedWith(compareByDescending<DocumentFile> { it.isDirectory }.thenBy { it.name?.lowercase() })
                        .forEach { file ->
                            add(PaneRow(file.name ?: return@forEach, file.isDirectory, file.length(), file.lastModified().takeIf { it > 0 }, file))
                        }
                }
                runOnUiThread {
                    localAdapter.rows = rows
                    localPane.path.text = directory.name ?: "Локальная папка"
                    selectedLocal = null
                    setBusy(false, "Локальная папка загружена")
                }
            } catch (error: Exception) {
                runOnUiThread { setBusy(false, "Ошибка папки: ${error.message}") }
            }
        }
    }

    private fun localUp() {
        if (localStack.isEmpty()) return
        localCurrent = localStack.removeLast()
        loadLocal()
    }

    private fun loadRemote() {
        val client = remoteClient ?: return
        val path = remotePath
        setBusy(true, "Чтение $path…")
        io.execute {
            try {
                val entries = client.list(path)
                val rows = buildList {
                    if (path != "/") add(PaneRow("..", true, 0, null, RemoteParent))
                    entries.forEach { add(PaneRow(it.name, it.directory, it.size, it.modifiedAt, it)) }
                }
                runOnUiThread {
                    if (path != remotePath) return@runOnUiThread
                    remoteAdapter.rows = rows
                    remotePane.path.text = path
                    selectedRemote = null
                    setBusy(false, "Серверная папка загружена")
                }
            } catch (error: Exception) {
                runOnUiThread { setBusy(false, "Ошибка сервера: ${error.message}") }
            }
        }
    }

    private fun remoteNavigate(path: String) {
        remotePath = RemotePath.normalize(path)
        loadRemote()
    }

    private fun uploadSelected() {
        val profile = selectedProfile ?: return toast("Нет подключения")
        val source = selectedLocal ?: return toast("Выберите локальный файл или папку")
        if (remoteClient == null) return toast("Нет подключения")
        transferEngine.upload(profile, source, remotePath)
        toast("Добавлено в очередь: ${source.name}")
    }

    private fun downloadSelected() {
        val profile = selectedProfile ?: return toast("Нет подключения")
        val source = selectedRemote ?: return toast("Выберите серверный файл или папку")
        val target = localCurrent ?: return toast("Выберите локальную папку")
        if (remoteClient == null) return toast("Нет подключения")
        transferEngine.download(profile, source.path, source.directory, source.size, target)
        toast("Добавлено в очередь: ${source.name}")
    }

    private fun confirmSync(upload: Boolean) {
        val profile = selectedProfile ?: return toast("Нет подключения")
        val local = localRoot ?: return toast("Выберите локальную папку")
        if (remoteClient == null) return toast("Нет подключения")
        AlertDialog.Builder(this)
            .setTitle(if (upload) "Обновить сервер?" else "Обновить локально?")
            .setMessage(
                if (upload) "Файлы вне локального .ftpignore с отличающимся размером будут загружены на сервер."
                else "Файлы вне серверного .ftpignore с отличающимся размером будут загружены в выбранную локальную папку."
            )
            .setNegativeButton("Отмена", null)
            .setPositiveButton("Продолжить") { _, _ ->
                transferEngine.sync(profile, local, remotePath, upload) { message ->
                    toast(message)
                    loadLocal()
                    loadRemote()
                }
            }
            .show()
    }

    private fun renderTransfers(states: List<TransferState>) {
        transferText.text = if (states.isEmpty()) "В работе: нет передач" else states.take(4).joinToString("\n") { state ->
            val progress = state.total?.takeIf { it > 0 }?.let { " ${state.transferred * 100 / it}%" }.orEmpty()
            when {
                state.error != null -> "${state.label} — ошибка: ${state.error}"
                state.finished -> "${state.label} — готово"
                else -> "${state.label}$progress"
            }
        }
    }

    private fun setBusy(value: Boolean, message: String) {
        busy.visibility = if (value) View.VISIBLE else View.GONE
        transferText.text = message
    }

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        textSize = 11f
        setOnClickListener { action() }
        isAllCaps = false
        minWidth = 0
        minimumWidth = 0
        setPadding(dp(7), 0, dp(7), 0)
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        remoteClient?.close()
        transferEngine.close()
        io.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val REQUEST_TREE = 401
    }
}
