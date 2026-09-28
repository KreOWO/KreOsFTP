package com.kreos.ftp.terminal

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.kreos.ftp.model.SiteProfile
import com.kreos.ftp.model.TerminalHotkey
import com.kreos.ftp.storage.SecureSiteStore

object TerminalDialog {
    fun show(
        activity: Activity,
        initialProfile: SiteProfile,
        store: SecureSiteStore,
        onProfileUpdated: (SiteProfile) -> Unit
    ) {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        fun button(label: String, action: () -> Unit) = Button(activity).apply {
            text = label
            textSize = 11f
            isAllCaps = false
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(9), 0, dp(9), 0)
            setOnClickListener { action() }
        }

        val dialog = Dialog(activity).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        var profile = initialProfile
        var session: SshTerminalSession? = null
        var columns = 80
        var rows = 24
        var pixelWidth = 800
        var pixelHeight = 480
        var hotkeys = store.hotkeys(profile.id)

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(12, 17, 23))
        }
        val toolbar = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(7), dp(3), dp(5), dp(3))
            setBackgroundColor(Color.rgb(20, 28, 37))
        }
        val status = TextView(activity).apply {
            text = "● SSH ${profile.name} — подключение…"
            textSize = 12f
            setTextColor(Color.rgb(77, 171, 247))
            maxLines = 1
        }
        toolbar.addView(status, LinearLayout.LayoutParams(0, dp(42), 1f))

        lateinit var terminal: TerminalView
        lateinit var quickKeys: LinearLayout
        fun toast(message: String) = Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        fun copy() {
            val text = terminal.selectedTextOrScreen()
            (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("SSH terminal", text))
            toast("Вывод скопирован")
        }
        fun paste() {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString().orEmpty()
            if (text.isNotEmpty()) terminal.send(text)
        }

        toolbar.addView(button("⧉", ::copy), LinearLayout.LayoutParams(dp(44), dp(40)))
        toolbar.addView(button("▣", ::paste), LinearLayout.LayoutParams(dp(44), dp(40)))
        toolbar.addView(button("⌨") {
            HotkeyDialog.show(
                activity,
                hotkeys,
                onSave = { updated ->
                    hotkeys = updated
                    store.saveHotkeys(profile.id, updated)
                    terminal.hotkeys = updated
                    renderQuickKeys(activity, quickKeys, updated, terminal, dp(38))
                },
                onDismiss = terminal::requestKeyboard
            )
        }, LinearLayout.LayoutParams(dp(48), dp(40)))
        toolbar.addView(button("Очистить") { terminal.clear() }, LinearLayout.LayoutParams(-2, dp(40)))
        toolbar.addView(button("×") { dialog.dismiss() }, LinearLayout.LayoutParams(dp(44), dp(40)))
        root.addView(toolbar)

        quickKeys = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(4), dp(2), dp(4), dp(2))
        }
        val quickScroll = HorizontalScrollView(activity).apply {
            isHorizontalScrollBarEnabled = true
            addView(quickKeys, ViewGroup.LayoutParams(-2, dp(43)))
        }
        root.addView(quickScroll, LinearLayout.LayoutParams(-1, dp(46)))

        terminal = TerminalView(activity).apply {
            this.hotkeys = hotkeys
            onSend = { session?.send(it) }
            onResize = { nextColumns, nextRows, width, height ->
                columns = nextColumns
                rows = nextRows
                pixelWidth = width
                pixelHeight = height
                session?.resize(columns, rows, pixelWidth, pixelHeight)
            }
        }
        root.addView(terminal, LinearLayout.LayoutParams(-1, 0, 1f))
        renderQuickKeys(activity, quickKeys, hotkeys, terminal, dp(38))

        fun start(nextProfile: SiteProfile) {
            session?.close()
            profile = nextProfile
            status.text = "● SSH ${profile.name} — подключение…"
            status.setTextColor(Color.rgb(250, 176, 5))
            terminal.feed("\r\n[Подключение к ${profile.host}:${profile.sshPort}…]\r\n")
            val next = SshTerminalSession(profile, object : SshTerminalSession.Listener {
                override fun onConnected() {
                    activity.runOnUiThread {
                        if (!dialog.isShowing) return@runOnUiThread
                        status.text = "● SSH ${profile.name}"
                        status.setTextColor(Color.rgb(81, 207, 102))
                        terminal.requestKeyboard()
                    }
                }

                override fun onText(text: String) = terminal.feed(text)

                override fun onHostKeyRequired(fingerprint: String) {
                    activity.runOnUiThread {
                        if (!dialog.isShowing) return@runOnUiThread
                        status.text = "● SSH — требуется проверка ключа"
                        status.setTextColor(Color.rgb(250, 176, 5))
                        AlertDialog.Builder(activity)
                            .setTitle("Новый SSH-сервер")
                            .setMessage("Сверьте SHA-256 отпечаток с администратором:\n\n$fingerprint")
                            .setNegativeButton("Отклонить") { _, _ ->
                                terminal.feed("\r\n[Ключ сервера отклонён]\r\n")
                            }
                            .setPositiveButton("Доверять") { _, _ ->
                                val updated = profile.copy(hostKeyFingerprint = fingerprint)
                                store.save(updated)
                                onProfileUpdated(updated)
                                start(updated)
                            }
                            .show()
                    }
                }

                override fun onClosed(message: String) {
                    activity.runOnUiThread {
                        if (!dialog.isShowing) return@runOnUiThread
                        status.text = "○ SSH ${profile.name} — отключено"
                        status.setTextColor(Color.rgb(140, 153, 171))
                        terminal.feed("\r\n[$message]\r\n")
                    }
                }
            })
            session = next
            next.connect(columns, rows, pixelWidth, pixelHeight)
        }

        dialog.setContentView(root)
        dialog.setOnDismissListener {
            session?.close()
            session = null
        }
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.rgb(12, 17, 23)))
            setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        }
        start(profile)
    }

    private fun renderQuickKeys(
        activity: Activity,
        container: LinearLayout,
        hotkeys: List<TerminalHotkey>,
        terminal: TerminalView,
        height: Int
    ) {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        container.removeAllViews()
        val builtIns = listOf(
            "Esc" to "\u001b",
            "Tab" to "\t",
            "Ctrl+C" to "\u0003",
            "Ctrl+D" to "\u0004",
            "Ctrl+Z" to "\u001a",
            "↑" to "\u001b[A",
            "↓" to "\u001b[B",
            "←" to "\u001b[D",
            "→" to "\u001b[C"
        )
        (builtIns + hotkeys.map { it.label to it.payload }).forEach { (label, sequence) ->
            container.addView(Button(activity).apply {
                text = label
                textSize = 10f
                isAllCaps = false
                minWidth = 0
                minimumWidth = 0
                setPadding(dp(9), 0, dp(9), 0)
                setOnClickListener {
                    terminal.send(sequence)
                    terminal.requestKeyboard()
                }
            }, LinearLayout.LayoutParams(-2, height))
        }
    }
}
