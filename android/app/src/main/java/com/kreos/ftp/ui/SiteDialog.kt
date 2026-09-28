package com.kreos.ftp.ui

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import com.kreos.ftp.model.Protocol
import com.kreos.ftp.model.SiteProfile

object SiteDialog {
    fun show(
        activity: Activity,
        existing: SiteProfile?,
        onSave: (SiteProfile) -> Unit,
        onDelete: ((SiteProfile) -> Unit)? = null
    ) {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val form = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(8), dp(22), dp(4))
        }
        fun label(value: String) = TextView(activity).also {
            it.text = value
            it.setPadding(0, dp(9), 0, dp(3))
            form.addView(it)
        }
        fun input(hint: String, value: String = "", password: Boolean = false): EditText =
            EditText(activity).also {
                it.hint = hint
                it.setText(value)
                it.setSingleLine(true)
                if (password) it.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                form.addView(it, ViewGroup.LayoutParams(-1, -2))
            }

        label("Протокол")
        val protocol = Spinner(activity).also {
            it.adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, Protocol.entries)
            it.setSelection(existing?.protocol?.ordinal ?: Protocol.SFTP.ordinal)
            form.addView(it)
        }
        label("Название")
        val name = input("Мой сервер", existing?.name.orEmpty())
        label("Сервер")
        val host = input("example.org", existing?.host.orEmpty())
        label("Порт")
        val port = input("22", existing?.port?.toString() ?: "22").apply {
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        label("Пользователь")
        val username = input("user", existing?.username.orEmpty())
        label("Пароль")
        val password = input("Пароль", existing?.password.orEmpty(), true)
        label("Начальная папка сервера")
        val remotePath = input("/", existing?.remotePath ?: "/")
        label("SSH-порт терминала")
        val sshPort = input("22", existing?.sshPort?.toString() ?: "22").apply {
            inputType = InputType.TYPE_CLASS_NUMBER
        }

        protocol.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                val selected = Protocol.entries[position]
                val previousDefault = Protocol.entries.firstOrNull { it.defaultPort.toString() == port.text.toString() }
                if (existing == null || previousDefault != null) port.setText(selected.defaultPort.toString())
            }
        }

        val scroll = ScrollView(activity).apply { addView(form) }
        val dialog = AlertDialog.Builder(activity)
            .setTitle(if (existing == null) "Новое подключение" else "Изменить подключение")
            .setView(scroll)
            .setNegativeButton("Отмена", null)
            .setPositiveButton("Сохранить", null)
            .apply {
                if (existing != null && onDelete != null) setNeutralButton("Удалить") { _, _ -> onDelete(existing) }
            }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    val selectedProtocol = Protocol.entries[protocol.selectedItemPosition]
                    val hostValue = host.text.toString().trim()
                    require(hostValue.isNotEmpty() && hostValue.none(Char::isWhitespace)) { "Укажите корректный сервер" }
                    val portValue = port.text.toString().toIntOrNull()
                    require(portValue != null && portValue in 1..65535) { "Порт должен быть от 1 до 65535" }
                    val sshPortValue = sshPort.text.toString().toIntOrNull()
                    require(sshPortValue != null && sshPortValue in 1..65535) { "SSH-порт должен быть от 1 до 65535" }
                    val nameValue = name.text.toString().trim()
                    require(nameValue.isNotEmpty()) { "Укажите название" }
                    val userValue = username.text.toString().trim()
                    require(userValue.isNotEmpty()) { "Укажите пользователя" }
                    onSave(
                        SiteProfile(
                            id = existing?.id ?: java.util.UUID.randomUUID().toString(),
                            name = nameValue,
                            protocol = selectedProtocol,
                            host = hostValue,
                            port = portValue,
                            username = userValue,
                            password = password.text.toString(),
                            remotePath = remotePath.text.toString().trim().ifEmpty { "/" },
                            sshPort = sshPortValue,
                            hostKeyFingerprint = existing?.hostKeyFingerprint?.takeIf {
                                existing.host == hostValue && existing.port == portValue &&
                                    existing.sshPort == sshPortValue && existing.protocol == selectedProtocol
                            }
                        )
                    )
                    dialog.dismiss()
                } catch (error: IllegalArgumentException) {
                    host.error = error.message
                }
            }
        }
        dialog.show()
    }
}
