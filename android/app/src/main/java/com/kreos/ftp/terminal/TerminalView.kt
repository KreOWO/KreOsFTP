package com.kreos.ftp.terminal

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.Selection
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import com.kreos.ftp.model.TerminalHotkey
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

class TerminalView(context: Context) : FrameLayout(context) {
    private data class RenderStyle(val foreground: Int, val background: Int, val bold: Boolean)
    var onSend: (String) -> Unit = {}
    var onResize: (columns: Int, rows: Int, width: Int, height: Int) -> Unit = { _, _, _, _ -> }
    var hotkeys: List<TerminalHotkey> = emptyList()

    private val buffer = AnsiTerminalBuffer()
    private val main = Handler(Looper.getMainLooper())
    private val renderPending = AtomicBoolean(false)
    private val display = TextView(context).apply {
        typeface = Typeface.MONOSPACE
        textSize = 13f
        includeFontPadding = false
        setLineSpacing(0f, 1.05f)
        setTextColor(DEFAULT_FOREGROUND)
        setBackgroundColor(DEFAULT_BACKGROUND)
        setPadding(dp(8), dp(6), dp(8), dp(6))
        setHorizontallyScrolling(true)
        setTextIsSelectable(true)
    }
    private val scroll = ScrollView(context).apply {
        isFillViewport = true
        setBackgroundColor(DEFAULT_BACKGROUND)
        addView(
            this@TerminalView.display,
            android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
            )
        )
    }
    private val input = TerminalInputView(context, ::handlePhysicalKey) { onSend(it) }

    init {
        isFocusable = true
        addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(input, LayoutParams(1, 1).apply {
            gravity = android.view.Gravity.BOTTOM or android.view.Gravity.END
        })
        display.setOnClickListener { requestKeyboard() }
        display.setOnLongClickListener {
            // Keep Android's native text-selection action mode available.
            false
        }
        scroll.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) resizeToViewport()
        }
        post {
            resizeToViewport()
            requestKeyboard()
            renderNow()
        }
    }

    fun feed(text: String) {
        val replies = buffer.feed(text)
        replies.forEach(onSend)
        scheduleRender()
    }

    fun send(text: String) = onSend(text)

    fun clear() {
        buffer.feed("\u001bc")
        scheduleRender()
    }

    fun selectedTextOrScreen(): String {
        val value = display.text
        val start = Selection.getSelectionStart(value)
        val end = Selection.getSelectionEnd(value)
        if (start >= 0 && end > start) return value.subSequence(start, end).toString()
        return buffer.snapshot().plainText()
    }

    fun requestKeyboard() {
        input.requestFocus()
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun resizeToViewport() {
        val width = max(1, scroll.width - display.paddingLeft - display.paddingRight)
        val height = max(1, scroll.height - display.paddingTop - display.paddingBottom)
        val characterWidth = max(1f, display.paint.measureText("M"))
        val lineHeight = max(1, display.lineHeight)
        val columns = max(2, (width / characterWidth).toInt())
        val rows = max(2, height / lineHeight)
        if (columns != buffer.columns || rows != buffer.rows) {
            buffer.resize(columns, rows)
            onResize(columns, rows, width, height)
            scheduleRender()
        }
    }

    private fun scheduleRender() {
        if (!renderPending.compareAndSet(false, true)) return
        main.postDelayed({
            renderPending.set(false)
            renderNow()
        }, 16)
    }

    private fun renderNow() {
        val stayAtBottom = scroll.scrollY + scroll.height >= display.height - display.lineHeight * 2
        display.text = styled(buffer.snapshot())
        if (stayAtBottom) scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun styled(snapshot: TerminalSnapshot): CharSequence {
        val output = SpannableStringBuilder()
        snapshot.lines.forEachIndexed { rowIndex, line ->
            var runStart = output.length
            var runStyle: RenderStyle? = null
            line.forEachIndexed { columnIndex, cell ->
                var foreground = color(cell.foreground, DEFAULT_FOREGROUND)
                var background = color(cell.background, DEFAULT_BACKGROUND)
                val cursor = snapshot.cursorVisible && rowIndex == snapshot.cursorLine && columnIndex == snapshot.cursorColumn
                if (cell.inverse || cursor) {
                    val swap = foreground
                    foreground = background
                    background = swap
                }
                val style = RenderStyle(foreground, background, cell.bold)
                if (runStyle != null && runStyle != style) {
                    applyStyle(output, runStart, output.length, runStyle!!)
                    runStart = output.length
                }
                runStyle = style
                output.append(String(Character.toChars(cell.codePoint)))
            }
            runStyle?.let { applyStyle(output, runStart, output.length, it) }
            if (rowIndex != snapshot.lines.lastIndex) output.append('\n')
        }
        return output
    }

    private fun applyStyle(output: SpannableStringBuilder, start: Int, end: Int, style: RenderStyle) {
        if (start >= end) return
        if (style.foreground != DEFAULT_FOREGROUND) {
            output.setSpan(ForegroundColorSpan(style.foreground), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (style.background != DEFAULT_BACKGROUND) {
            output.setSpan(BackgroundColorSpan(style.background), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        if (style.bold) output.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    private fun handlePhysicalKey(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return false
        if (event.repeatCount == 0) {
            hotkeys.firstOrNull { hotkey ->
                hotkey.keyCode == event.keyCode &&
                    hotkey.ctrl == event.isCtrlPressed &&
                    hotkey.alt == event.isAltPressed &&
                    hotkey.shift == event.isShiftPressed
            }?.let {
                onSend(it.payload)
                return true
            }
        }
        val sequence = when (event.keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "\r"
            KeyEvent.KEYCODE_DEL -> "\u007f"
            KeyEvent.KEYCODE_FORWARD_DEL -> "\u001b[3~"
            KeyEvent.KEYCODE_TAB -> if (event.isShiftPressed) "\u001b[Z" else "\t"
            KeyEvent.KEYCODE_ESCAPE -> "\u001b"
            KeyEvent.KEYCODE_DPAD_UP -> "\u001b[A"
            KeyEvent.KEYCODE_DPAD_DOWN -> "\u001b[B"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "\u001b[C"
            KeyEvent.KEYCODE_DPAD_LEFT -> "\u001b[D"
            KeyEvent.KEYCODE_MOVE_HOME -> "\u001b[H"
            KeyEvent.KEYCODE_MOVE_END -> "\u001b[F"
            KeyEvent.KEYCODE_PAGE_UP -> "\u001b[5~"
            KeyEvent.KEYCODE_PAGE_DOWN -> "\u001b[6~"
            KeyEvent.KEYCODE_INSERT -> "\u001b[2~"
            else -> printableSequence(event)
        }
        if (sequence == null) return false
        onSend(sequence)
        return true
    }

    private fun printableSequence(event: KeyEvent): String? {
        if (event.isCtrlPressed) {
            val control = when (event.keyCode) {
                in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> event.keyCode - KeyEvent.KEYCODE_A + 1
                KeyEvent.KEYCODE_SPACE -> 0
                KeyEvent.KEYCODE_LEFT_BRACKET -> 27
                KeyEvent.KEYCODE_BACKSLASH -> 28
                KeyEvent.KEYCODE_RIGHT_BRACKET -> 29
                KeyEvent.KEYCODE_GRAVE -> 30
                KeyEvent.KEYCODE_MINUS -> 31
                else -> return null
            }
            return (if (event.isAltPressed) "\u001b" else "") + control.toChar()
        }
        val unicode = event.unicodeChar
        if (unicode == 0) return null
        return (if (event.isAltPressed) "\u001b" else "") + String(Character.toChars(unicode))
    }

    private fun color(value: Int, fallback: Int): Int {
        if (value < 0) return fallback
        if (value >= 256) return Color.rgb((value shr 16) and 0xff, (value shr 8) and 0xff, value and 0xff)
        if (value < ANSI.size) return ANSI[value]
        if (value in 16..231) {
            val offset = value - 16
            val red = offset / 36
            val green = offset / 6 % 6
            val blue = offset % 6
            fun channel(component: Int) = if (component == 0) 0 else 55 + component * 40
            return Color.rgb(channel(red), channel(green), channel(blue))
        }
        val gray = 8 + (value - 232).coerceIn(0, 23) * 10
        return Color.rgb(gray, gray, gray)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private class TerminalInputView(
        context: Context,
        private val onPhysicalKey: (KeyEvent) -> Boolean,
        private val onText: (String) -> Unit
    ) : View(context) {
        init {
            isFocusable = true
            isFocusableInTouchMode = true
            alpha = 0.01f
        }

        override fun onCheckIsTextEditor(): Boolean = true

        override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
            outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE
            outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
            return object : BaseInputConnection(this, false) {
                private var composing: String? = null

                override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                    composing = null
                    text?.takeIf { it.isNotEmpty() }?.let { onText(it.toString()) }
                    return true
                }

                override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
                    composing = text?.toString()
                    return true
                }

                override fun finishComposingText(): Boolean {
                    composing?.takeIf(String::isNotEmpty)?.let(onText)
                    composing = null
                    return true
                }

                override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                    repeat(beforeLength.coerceAtLeast(1)) { onText("\u007f") }
                    return true
                }

                override fun sendKeyEvent(event: KeyEvent): Boolean = onPhysicalKey(event)

                override fun performEditorAction(actionCode: Int): Boolean {
                    onText("\r")
                    return true
                }
            }
        }

        override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = onPhysicalKey(event) || super.onKeyDown(keyCode, event)
        override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean = onPhysicalKey(event) || super.onKeyUp(keyCode, event)
        override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
            event.characters?.let {
                onText(it)
                return true
            }
            return super.onKeyMultiple(keyCode, repeatCount, event)
        }
    }

    companion object {
        private val DEFAULT_FOREGROUND = Color.rgb(215, 224, 234)
        private val DEFAULT_BACKGROUND = Color.rgb(8, 12, 17)
        private val ANSI = intArrayOf(
            Color.rgb(0, 0, 0), Color.rgb(205, 49, 49), Color.rgb(13, 188, 121), Color.rgb(229, 229, 16),
            Color.rgb(36, 114, 200), Color.rgb(188, 63, 188), Color.rgb(17, 168, 205), Color.rgb(229, 229, 229),
            Color.rgb(102, 102, 102), Color.rgb(241, 76, 76), Color.rgb(35, 209, 139), Color.rgb(245, 245, 67),
            Color.rgb(59, 142, 234), Color.rgb(214, 112, 214), Color.rgb(41, 184, 219), Color.rgb(255, 255, 255)
        )
    }
}
