package com.kreos.ftp.terminal

import kotlin.math.max
import kotlin.math.min

data class TerminalCell(
    val codePoint: Int = ' '.code,
    val foreground: Int = -1,
    val background: Int = -1,
    val bold: Boolean = false,
    val inverse: Boolean = false
)

data class TerminalSnapshot(
    val lines: List<List<TerminalCell>>,
    val cursorLine: Int,
    val cursorColumn: Int,
    val cursorVisible: Boolean
) {
    fun plainText(): String = lines.joinToString("\n") { line ->
        line.joinToString("") { cell -> String(Character.toChars(cell.codePoint)) }.trimEnd()
    }.trimEnd()
}

/** A compact VT100/xterm screen model used by the native Android terminal view. */
class AnsiTerminalBuffer(
    columns: Int = 80,
    rows: Int = 24,
    private val scrollbackLimit: Int = 2_000
) {
    private enum class ParserState { TEXT, ESCAPE, CSI, OSC, OSC_ESCAPE }
    private data class SavedScreen(
        val cells: Array<Array<TerminalCell>>,
        val row: Int,
        val column: Int,
        val scrollTop: Int,
        val scrollBottom: Int
    )

    var columns: Int = columns.coerceAtLeast(2)
        private set
    var rows: Int = rows.coerceAtLeast(2)
        private set

    private var screen = blankScreen(this.rows, this.columns)
    private val scrollback = ArrayDeque<Array<TerminalCell>>()
    private var cursorRow = 0
    private var cursorColumn = 0
    private var savedRow = 0
    private var savedColumn = 0
    private var scrollTop = 0
    private var scrollBottom = this.rows - 1
    private var foreground = -1
    private var background = -1
    private var bold = false
    private var inverse = false
    private var cursorVisible = true
    private var wrapPending = false
    private var originMode = false
    private var parserState = ParserState.TEXT
    private val sequence = StringBuilder()
    private var mainScreen: SavedScreen? = null

    @Synchronized
    fun feed(text: String): List<String> {
        val replies = mutableListOf<String>()
        var offset = 0
        while (offset < text.length) {
            val codePoint = text.codePointAt(offset)
            offset += Character.charCount(codePoint)
            when (parserState) {
                ParserState.TEXT -> consumeText(codePoint)
                ParserState.ESCAPE -> consumeEscape(codePoint)
                ParserState.CSI -> {
                    if (codePoint in 0x40..0x7e) {
                        handleCsi(codePoint.toChar(), sequence.toString(), replies)
                        sequence.clear()
                        parserState = ParserState.TEXT
                    } else if (sequence.length < 128) {
                        sequence.appendCodePoint(codePoint)
                    } else {
                        sequence.clear()
                        parserState = ParserState.TEXT
                    }
                }
                ParserState.OSC -> when (codePoint) {
                    0x07 -> parserState = ParserState.TEXT
                    0x1b -> parserState = ParserState.OSC_ESCAPE
                    else -> Unit
                }
                ParserState.OSC_ESCAPE -> parserState = if (codePoint == '\\'.code) {
                    ParserState.TEXT
                } else {
                    ParserState.OSC
                }
            }
        }
        return replies
    }

    @Synchronized
    fun resize(newColumns: Int, newRows: Int) {
        val targetColumns = newColumns.coerceAtLeast(2)
        val targetRows = newRows.coerceAtLeast(2)
        if (targetColumns == columns && targetRows == rows) return
        val oldRows = rows
        val resizedCurrent = resizeCells(screen, targetRows, targetColumns)
        cursorRow = resizedRow(cursorRow, oldRows, targetRows)
        cursorColumn = cursorColumn.coerceIn(0, targetColumns - 1)
        mainScreen = mainScreen?.let { saved ->
            saved.copy(
                cells = resizeCells(saved.cells, targetRows, targetColumns),
                row = resizedRow(saved.row, oldRows, targetRows),
                column = saved.column.coerceIn(0, targetColumns - 1),
                scrollTop = 0,
                scrollBottom = targetRows - 1
            )
        }
        columns = targetColumns
        rows = targetRows
        screen = resizedCurrent
        scrollTop = 0
        scrollBottom = rows - 1
        wrapPending = false
    }

    @Synchronized
    fun snapshot(includeScrollback: Boolean = true): TerminalSnapshot {
        val history = if (includeScrollback && mainScreen == null) scrollback.map { it.toList() } else emptyList()
        val lines = history + screen.map { it.toList() }
        return TerminalSnapshot(
            lines = lines,
            cursorLine = history.size + cursorRow,
            cursorColumn = cursorColumn,
            cursorVisible = cursorVisible
        )
    }

    @Synchronized
    fun clearScrollback() = scrollback.clear()

    private fun consumeText(codePoint: Int) {
        when (codePoint) {
            0x00, 0x07 -> Unit
            0x08 -> {
                wrapPending = false
                cursorColumn = max(0, cursorColumn - 1)
            }
            0x09 -> {
                wrapPending = false
                cursorColumn = min(columns - 1, ((cursorColumn / 8) + 1) * 8)
            }
            0x0a, 0x0b, 0x0c -> {
                wrapPending = false
                lineFeed()
            }
            0x0d -> {
                wrapPending = false
                cursorColumn = 0
            }
            0x1b -> parserState = ParserState.ESCAPE
            else -> if (codePoint >= 0x20 && codePoint != 0x7f) put(codePoint)
        }
    }

    private fun consumeEscape(codePoint: Int) {
        parserState = ParserState.TEXT
        wrapPending = false
        when (codePoint.toChar()) {
            '[' -> {
                sequence.clear()
                parserState = ParserState.CSI
            }
            ']' -> parserState = ParserState.OSC
            '7' -> saveCursor()
            '8' -> restoreCursor()
            'D' -> lineFeed()
            'E' -> {
                cursorColumn = 0
                lineFeed()
            }
            'M' -> reverseIndex()
            'c' -> reset()
            'H' -> Unit // Horizontal tab set; fixed eight-column tabs are used.
            else -> Unit
        }
    }

    private fun handleCsi(final: Char, raw: String, replies: MutableList<String>) {
        if (final != 'm') wrapPending = false
        val privateMode = raw.startsWith('?')
        val cleaned = raw.trimStart('?', '>', '!').substringBefore(':')
        val params = if (cleaned.isBlank()) emptyList() else cleaned.split(';').map { it.toIntOrNull() ?: 0 }
        fun value(index: Int, fallback: Int = 1): Int = params.getOrNull(index)?.takeIf { it != 0 } ?: fallback
        when (final) {
            'A' -> cursorRow = max(if (originMode) scrollTop else 0, cursorRow - value(0))
            'B' -> cursorRow = min(if (originMode) scrollBottom else rows - 1, cursorRow + value(0))
            'C', 'a' -> cursorColumn = min(columns - 1, cursorColumn + value(0))
            'D' -> cursorColumn = max(0, cursorColumn - value(0))
            'E' -> {
                cursorRow = min(rows - 1, cursorRow + value(0))
                cursorColumn = 0
            }
            'F' -> {
                cursorRow = max(0, cursorRow - value(0))
                cursorColumn = 0
            }
            'G', '`' -> cursorColumn = (value(0) - 1).coerceIn(0, columns - 1)
            'd' -> cursorRow = absoluteRow(value(0) - 1)
            'H', 'f' -> {
                cursorRow = absoluteRow(value(0) - 1)
                cursorColumn = (value(1) - 1).coerceIn(0, columns - 1)
            }
            'J' -> eraseDisplay(params.firstOrNull() ?: 0)
            'K' -> eraseLine(params.firstOrNull() ?: 0)
            'm' -> setGraphics(params.ifEmpty { listOf(0) })
            's' -> saveCursor()
            'u' -> restoreCursor()
            'r' -> setScrollRegion(value(0), params.getOrNull(1)?.takeIf { it != 0 } ?: rows)
            'L' -> insertLines(value(0))
            'M' -> deleteLines(value(0))
            '@' -> insertCharacters(value(0))
            'P' -> deleteCharacters(value(0))
            'X' -> eraseCharacters(value(0))
            'S' -> repeat(value(0).coerceAtMost(rows)) { scrollUp() }
            'T' -> repeat(value(0).coerceAtMost(rows)) { scrollDown() }
            'h', 'l' -> if (privateMode) setPrivateModes(params, final == 'h')
            'n' -> when (params.firstOrNull()) {
                5 -> replies += "\u001b[0n"
                6 -> replies += "\u001b[${cursorRow + 1};${cursorColumn + 1}R"
            }
            'c' -> replies += "\u001b[?1;2c"
        }
    }

    private fun absoluteRow(requested: Int): Int {
        val base = if (originMode) scrollTop else 0
        val maxRow = if (originMode) scrollBottom else rows - 1
        return (base + requested).coerceIn(base, maxRow)
    }

    private fun put(codePoint: Int) {
        if (wrapPending) {
            cursorColumn = 0
            lineFeed()
            wrapPending = false
        }
        screen[cursorRow][cursorColumn] = currentCell(codePoint)
        if (cursorColumn == columns - 1) {
            wrapPending = true
        } else {
            cursorColumn++
        }
    }

    private fun lineFeed() {
        if (cursorRow == scrollBottom) scrollUp()
        else cursorRow = min(rows - 1, cursorRow + 1)
    }

    private fun reverseIndex() {
        if (cursorRow == scrollTop) scrollDown()
        else cursorRow = max(0, cursorRow - 1)
    }

    private fun scrollUp() {
        val removed = screen[scrollTop]
        for (row in scrollTop until scrollBottom) screen[row] = screen[row + 1]
        screen[scrollBottom] = blankLine(columns)
        if (scrollTop == 0 && scrollBottom == rows - 1 && mainScreen == null) {
            scrollback.addLast(removed.copyOf())
            while (scrollback.size > scrollbackLimit) scrollback.removeFirst()
        }
    }

    private fun scrollDown() {
        for (row in scrollBottom downTo scrollTop + 1) screen[row] = screen[row - 1]
        screen[scrollTop] = blankLine(columns)
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> {
                eraseLine(0)
                for (row in cursorRow + 1 until rows) screen[row] = blankLine(columns)
            }
            1 -> {
                eraseLine(1)
                for (row in 0 until cursorRow) screen[row] = blankLine(columns)
            }
            2 -> repeat(rows) { screen[it] = blankLine(columns) }
            3 -> scrollback.clear()
        }
    }

    private fun eraseLine(mode: Int) {
        val range = when (mode) {
            1 -> 0..cursorColumn
            2 -> 0 until columns
            else -> cursorColumn until columns
        }
        range.forEach { screen[cursorRow][it] = currentCell(' '.code) }
    }

    private fun insertLines(amount: Int) {
        if (cursorRow !in scrollTop..scrollBottom) return
        repeat(amount.coerceAtMost(scrollBottom - cursorRow + 1)) {
            for (row in scrollBottom downTo cursorRow + 1) screen[row] = screen[row - 1]
            screen[cursorRow] = blankLine(columns)
        }
    }

    private fun deleteLines(amount: Int) {
        if (cursorRow !in scrollTop..scrollBottom) return
        repeat(amount.coerceAtMost(scrollBottom - cursorRow + 1)) {
            for (row in cursorRow until scrollBottom) screen[row] = screen[row + 1]
            screen[scrollBottom] = blankLine(columns)
        }
    }

    private fun insertCharacters(amount: Int) {
        val count = amount.coerceAtMost(columns - cursorColumn)
        for (column in columns - 1 downTo cursorColumn + count) {
            screen[cursorRow][column] = screen[cursorRow][column - count]
        }
        repeat(count) { screen[cursorRow][cursorColumn + it] = currentCell(' '.code) }
    }

    private fun deleteCharacters(amount: Int) {
        val count = amount.coerceAtMost(columns - cursorColumn)
        for (column in cursorColumn until columns - count) {
            screen[cursorRow][column] = screen[cursorRow][column + count]
        }
        for (column in columns - count until columns) screen[cursorRow][column] = currentCell(' '.code)
    }

    private fun eraseCharacters(amount: Int) {
        repeat(amount.coerceAtMost(columns - cursorColumn)) {
            screen[cursorRow][cursorColumn + it] = currentCell(' '.code)
        }
    }

    private fun setScrollRegion(top: Int, bottom: Int) {
        val first = (top - 1).coerceIn(0, rows - 1)
        val last = (bottom - 1).coerceIn(0, rows - 1)
        if (first >= last) return
        scrollTop = first
        scrollBottom = last
        cursorRow = if (originMode) first else 0
        cursorColumn = 0
    }

    private fun setPrivateModes(modes: List<Int>, enabled: Boolean) {
        modes.forEach { mode ->
            when (mode) {
                6 -> {
                    originMode = enabled
                    cursorRow = if (enabled) scrollTop else 0
                    cursorColumn = 0
                }
                25 -> cursorVisible = enabled
                47, 1047, 1049 -> if (enabled) enterAlternateScreen() else leaveAlternateScreen()
            }
        }
    }

    private fun enterAlternateScreen() {
        if (mainScreen != null) return
        mainScreen = SavedScreen(screen, cursorRow, cursorColumn, scrollTop, scrollBottom)
        screen = blankScreen(rows, columns)
        cursorRow = 0
        cursorColumn = 0
        scrollTop = 0
        scrollBottom = rows - 1
    }

    private fun leaveAlternateScreen() {
        val saved = mainScreen ?: return
        screen = saved.cells
        cursorRow = saved.row.coerceIn(0, rows - 1)
        cursorColumn = saved.column.coerceIn(0, columns - 1)
        scrollTop = saved.scrollTop.coerceIn(0, rows - 1)
        scrollBottom = saved.scrollBottom.coerceIn(scrollTop, rows - 1)
        mainScreen = null
        wrapPending = false
    }

    private fun setGraphics(values: List<Int>) {
        var index = 0
        while (index < values.size) {
            when (val value = values[index]) {
                0 -> {
                    foreground = -1
                    background = -1
                    bold = false
                    inverse = false
                }
                1 -> bold = true
                2, 22 -> bold = false
                7 -> inverse = true
                27 -> inverse = false
                30, 31, 32, 33, 34, 35, 36, 37 -> foreground = value - 30
                39 -> foreground = -1
                40, 41, 42, 43, 44, 45, 46, 47 -> background = value - 40
                49 -> background = -1
                90, 91, 92, 93, 94, 95, 96, 97 -> foreground = value - 90 + 8
                100, 101, 102, 103, 104, 105, 106, 107 -> background = value - 100 + 8
                38, 48 -> {
                    val foregroundTarget = value == 38
                    when (values.getOrNull(index + 1)) {
                        5 -> {
                            val color = values.getOrNull(index + 2)?.coerceIn(0, 255)
                            if (color != null) {
                                if (foregroundTarget) foreground = color else background = color
                                index += 2
                            }
                        }
                        2 -> {
                            val red = values.getOrNull(index + 2)
                            val green = values.getOrNull(index + 3)
                            val blue = values.getOrNull(index + 4)
                            if (red != null && green != null && blue != null) {
                                val rgb = 256 + (red.coerceIn(0, 255) shl 16) +
                                    (green.coerceIn(0, 255) shl 8) + blue.coerceIn(0, 255)
                                if (foregroundTarget) foreground = rgb else background = rgb
                                index += 4
                            }
                        }
                    }
                }
            }
            index++
        }
    }

    private fun saveCursor() {
        savedRow = cursorRow
        savedColumn = cursorColumn
    }

    private fun restoreCursor() {
        cursorRow = savedRow.coerceIn(0, rows - 1)
        cursorColumn = savedColumn.coerceIn(0, columns - 1)
    }

    private fun reset() {
        screen = blankScreen(rows, columns)
        scrollback.clear()
        cursorRow = 0
        cursorColumn = 0
        scrollTop = 0
        scrollBottom = rows - 1
        foreground = -1
        background = -1
        bold = false
        inverse = false
        cursorVisible = true
        originMode = false
        mainScreen = null
    }

    private fun currentCell(codePoint: Int) = TerminalCell(codePoint, foreground, background, bold, inverse)
    private fun blankLine(columns: Int) = Array(columns) { TerminalCell() }
    private fun blankScreen(rows: Int, columns: Int) = Array(rows) { blankLine(columns) }

    private fun resizeCells(source: Array<Array<TerminalCell>>, targetRows: Int, targetColumns: Int): Array<Array<TerminalCell>> {
        val replacement = blankScreen(targetRows, targetColumns)
        val copiedRows = min(source.size, targetRows)
        val sourceStart = max(0, source.size - copiedRows)
        val targetStart = max(0, targetRows - copiedRows)
        repeat(copiedRows) { row ->
            repeat(min(source[sourceStart + row].size, targetColumns)) { column ->
                replacement[targetStart + row][column] = source[sourceStart + row][column]
            }
        }
        return replacement
    }

    private fun resizedRow(row: Int, oldRows: Int, targetRows: Int): Int {
        val copiedRows = min(oldRows, targetRows)
        val sourceStart = max(0, oldRows - copiedRows)
        val targetStart = max(0, targetRows - copiedRows)
        return (targetStart + row - sourceStart).coerceIn(0, targetRows - 1)
    }
}
