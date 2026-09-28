package com.kreos.ftp.terminal

object HotkeyCodec {
    fun decode(value: String): String {
        val output = StringBuilder()
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char != '\\' || index == value.lastIndex) {
                output.append(char)
                index++
                continue
            }
            val next = value[index + 1]
            when (next) {
                'e', 'E' -> output.append('\u001b')
                'n' -> output.append('\n')
                'r' -> output.append('\r')
                't' -> output.append('\t')
                '\\' -> output.append('\\')
                'x' -> {
                    val hex = value.substring(index + 2, (index + 4).coerceAtMost(value.length))
                    val decoded = hex.takeIf { it.length == 2 }?.toIntOrNull(16)
                    if (decoded != null) {
                        output.append(decoded.toChar())
                        index += 4
                        continue
                    }
                    output.append("\\x")
                }
                else -> output.append(next)
            }
            index += 2
        }
        return output.toString()
    }

    fun encode(value: String): String = buildString {
        value.forEach { char ->
            when (char) {
                '\u001b' -> append("\\e")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                '\\' -> append("\\\\")
                else -> if (char.code < 0x20 || char.code == 0x7f) {
                    append("\\x").append(char.code.toString(16).padStart(2, '0'))
                } else append(char)
            }
        }
    }
}
