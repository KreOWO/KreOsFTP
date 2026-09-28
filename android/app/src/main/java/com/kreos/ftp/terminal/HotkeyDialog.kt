package com.kreos.ftp.terminal

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.kreos.ftp.model.TerminalHotkey

object HotkeyDialog {
    fun show(
        activity: Activity,
        initial: List<TerminalHotkey>,
        onSave: (List<TerminalHotkey>) -> Unit,
        onDismiss: () -> Unit = {}
    ) {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val items = initial.toMutableList()
        var selected = -1
        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(8), dp(14), dp(4))
        }
        val help = TextView(activity).apply {
            text = "Кнопка отображается над терминалом. Физическое сочетание необязательно. " +
                "В команде доступны \\e, \\r, \\n, \\t и \\xNN."
            setPadding(dp(4), 0, dp(4), dp(8))
        }
        root.addView(help)
        val list = ListView(activity)
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        val actions = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val add = Button(activity).apply { text = "+" }
        val editButton = Button(activity).apply { text = "Изменить" }
        val removeButton = Button(activity).apply { text = "Удалить" }
        actions.addView(add, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(editButton, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(removeButton, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(actions)

        fun render() {
            list.adapter = ArrayAdapter(
                activity,
                android.R.layout.simple_list_item_activated_1,
                items.map { "${it.label}    ${chord(it)}" }
            )
            list.choiceMode = ListView.CHOICE_MODE_SINGLE
            if (selected in items.indices) list.setItemChecked(selected, true)
            editButton.isEnabled = selected in items.indices
            removeButton.isEnabled = selected in items.indices
        }
        list.setOnItemClickListener { _, _, position, _ ->
            selected = position
            render()
        }
        val manager = AlertDialog.Builder(activity)
            .setTitle("Хоткеи SSH")
            .setView(root)
            .setNegativeButton("Отмена", null)
            .setPositiveButton("Сохранить") { _, _ -> onSave(items.toList()) }
            .create()
        add.setOnClickListener {
            edit(activity, null) { items += it; selected = items.lastIndex; render() }
        }
        editButton.setOnClickListener {
            val index = selected
            if (index in items.indices) edit(activity, items[index]) { items[index] = it; render() }
        }
        removeButton.setOnClickListener {
            val index = selected
            if (index in items.indices) {
                items.removeAt(index)
                selected = (index - 1).coerceAtMost(items.lastIndex)
                render()
            }
        }
        render()
        manager.setOnDismissListener { onDismiss() }
        manager.show()
        manager.window?.setLayout((activity.resources.displayMetrics.widthPixels * 0.92).toInt(),
            (activity.resources.displayMetrics.heightPixels * 0.82).toInt())
    }

    private fun edit(activity: Activity, existing: TerminalHotkey?, onSave: (TerminalHotkey) -> Unit) {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        val form = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(5), dp(22), 0)
        }
        fun label(text: String) = TextView(activity).also {
            it.text = text
            it.setPadding(0, dp(8), 0, dp(2))
            form.addView(it)
        }
        label("Название кнопки")
        val name = EditText(activity).apply {
            setText(existing?.label.orEmpty())
            hint = "Например: Логи"
            setSingleLine(true)
        }
        form.addView(name)
        label("Что отправить в терминал")
        val hadEnter = existing?.payload?.endsWith('\r') == true
        val command = EditText(activity).apply {
            setText(HotkeyCodec.encode(existing?.payload?.removeSuffix("\r").orEmpty()))
            hint = "docker compose logs -f"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2
        }
        form.addView(command)
        val appendEnter = CheckBox(activity).apply {
            text = "Нажать Enter после команды"
            isChecked = existing == null || hadEnter
        }
        form.addView(appendEnter)

        var keyCode = existing?.keyCode
        var ctrl = existing?.ctrl ?: false
        var alt = existing?.alt ?: false
        var shift = existing?.shift ?: false
        var capturing = false
        label("Физическое сочетание")
        val capture = Button(activity)
        fun updateCapture() {
            capture.text = if (capturing) "Нажмите сочетание…" else chord(keyCode, ctrl, alt, shift)
        }
        capture.setOnClickListener {
            capturing = true
            updateCapture()
        }
        form.addView(capture, ViewGroup.LayoutParams(-1, -2))
        val clear = Button(activity).apply {
            text = "Убрать физическое сочетание"
            setOnClickListener {
                keyCode = null
                ctrl = false
                alt = false
                shift = false
                capturing = false
                updateCapture()
            }
        }
        form.addView(clear)
        updateCapture()

        val dialog = AlertDialog.Builder(activity)
            .setTitle(if (existing == null) "Новый хоткей" else "Изменить хоткей")
            .setView(form)
            .setNegativeButton("Отмена", null)
            .setPositiveButton("Готово", null)
            .create()
        dialog.setOnKeyListener { _, pressed, event ->
            if (!capturing || event.action != KeyEvent.ACTION_DOWN || isModifier(pressed)) return@setOnKeyListener false
            keyCode = pressed
            ctrl = event.isCtrlPressed
            alt = event.isAltPressed
            shift = event.isShiftPressed
            capturing = false
            updateCapture()
            true
        }
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val labelValue = name.text.toString().trim()
                if (labelValue.isEmpty()) {
                    name.error = "Укажите название"
                    return@setOnClickListener
                }
                var payload = HotkeyCodec.decode(command.text.toString())
                if (appendEnter.isChecked) payload += '\r'
                if (payload.isEmpty()) {
                    command.error = "Укажите команду или последовательность"
                    return@setOnClickListener
                }
                onSave(
                    TerminalHotkey(
                        id = existing?.id ?: java.util.UUID.randomUUID().toString(),
                        label = labelValue,
                        payload = payload,
                        keyCode = keyCode,
                        ctrl = ctrl,
                        alt = alt,
                        shift = shift
                    )
                )
                dialog.dismiss()
            }
        }
        dialog.show()
    }

    private fun isModifier(keyCode: Int): Boolean = keyCode in setOf(
        KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT,
        KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT,
        KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT,
        KeyEvent.KEYCODE_META_LEFT, KeyEvent.KEYCODE_META_RIGHT
    )

    fun chord(hotkey: TerminalHotkey): String = chord(hotkey.keyCode, hotkey.ctrl, hotkey.alt, hotkey.shift)

    private fun chord(keyCode: Int?, ctrl: Boolean, alt: Boolean, shift: Boolean): String {
        if (keyCode == null) return "только кнопка"
        return buildList {
            if (ctrl) add("Ctrl")
            if (alt) add("Alt")
            if (shift) add("Shift")
            add(KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_"))
        }.joinToString("+")
    }
}
