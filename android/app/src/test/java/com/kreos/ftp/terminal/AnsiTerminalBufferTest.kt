package com.kreos.ftp.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AnsiTerminalBufferTest {
    @Test fun cursorMovementAndEraseWork() {
        val terminal = AnsiTerminalBuffer(10, 3)
        terminal.feed("hello\r\nworld")
        terminal.feed("\u001b[1A\u001b[2K\rtop")
        val lines = terminal.snapshot(false).plainText().lines()
        assertEquals("top", lines[0])
        assertEquals("world", lines[1])
    }

    @Test fun colorsAndAlternateScreenAreHandled() {
        val terminal = AnsiTerminalBuffer(8, 2)
        terminal.feed("main")
        terminal.feed("\u001b[?1049h\u001b[31mred")
        assertTrue(terminal.snapshot(false).plainText().contains("red"))
        assertEquals(1, terminal.snapshot(false).lines[0][0].foreground)
        terminal.feed("\u001b[?1049l")
        assertTrue(terminal.snapshot(false).plainText().contains("main"))
    }

    @Test fun terminalRepliesToCursorStatusRequest() {
        val terminal = AnsiTerminalBuffer(8, 2)
        terminal.feed("abc")
        assertEquals(listOf("\u001b[1;4R"), terminal.feed("\u001b[6n"))
    }

    @Test fun autoWrapWaitsForTheNextCharacter() {
        val terminal = AnsiTerminalBuffer(4, 2)
        terminal.feed("abcd")
        var snapshot = terminal.snapshot(false)
        assertEquals(0, snapshot.cursorLine)
        assertEquals(3, snapshot.cursorColumn)
        terminal.feed("e")
        snapshot = terminal.snapshot(false)
        assertEquals("abcd", snapshot.plainText().lines()[0])
        assertEquals("e", snapshot.plainText().lines()[1])
    }

    @Test fun resizeDoesNotLoseTheMainScreenBehindAlternateScreen() {
        val terminal = AnsiTerminalBuffer(8, 2)
        terminal.feed("main\u001b[?1049halt")
        terminal.resize(12, 4)
        terminal.feed("\u001b[?1049l")
        assertTrue(terminal.snapshot(false).plainText().contains("main"))
    }

    @Test fun hotkeyEscapesRoundTrip() {
        val raw = "\u001b[3~\r\n\u0003\\"
        assertEquals(raw, HotkeyCodec.decode(HotkeyCodec.encode(raw)))
    }
}
