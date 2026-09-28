package com.kreos.ftp.sync

/** Gitignore-compatible deployment rules. The control file itself is always excluded. */
class FtpIgnore(text: String) {
    private data class Rule(val negate: Boolean, val directoryOnly: Boolean, val pattern: Regex)

    private val rules = text.lineSequence().mapNotNull(::parseRule).toList()

    fun ignores(path: String, directory: Boolean): Boolean {
        val candidate = normalize(path)
        if (candidate.isEmpty()) return false
        if (candidate == ".ftpignore" || candidate.endsWith("/.ftpignore")) return true
        val segments = candidate.split('/')
        val ancestors = (1 until segments.size).map { segments.take(it).joinToString("/") }
        var ignored = false
        rules.forEach { rule ->
            val self = (!rule.directoryOnly || directory) && rule.pattern.matches(candidate)
            val parent = ancestors.any(rule.pattern::matches)
            if (self || parent) ignored = !rule.negate
        }
        return ignored
    }

    private fun parseRule(raw: String): Rule? {
        var line = raw.trim()
        if (line.isEmpty() || line.startsWith('#')) return null
        var negate = false
        if (line.startsWith('!')) {
            negate = true
            line = line.drop(1)
        } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
            line = line.drop(1)
        }
        val anchored = line.startsWith('/')
        if (anchored) line = line.drop(1)
        val directoryOnly = line.endsWith('/')
        if (directoryOnly) line = line.dropLast(1)
        if (line.isEmpty()) return null
        val anyDepth = !anchored && !line.contains('/')
        return Rule(negate, directoryOnly, glob(line, anyDepth))
    }

    private fun glob(value: String, anyDepth: Boolean): Regex {
        val output = StringBuilder(if (anyDepth) "^(?:.*/)?" else "^")
        var index = 0
        while (index < value.length) {
            when (val char = value[index]) {
                '*' -> {
                    if (index + 1 < value.length && value[index + 1] == '*') {
                        while (index + 1 < value.length && value[index + 1] == '*') index++
                        if (index + 1 < value.length && value[index + 1] == '/') {
                            index++
                            output.append("(?:.*/)?")
                        } else output.append(".*")
                    } else output.append("[^/]*")
                }
                '?' -> output.append("[^/]")
                '[' -> {
                    val end = value.indexOf(']', index + 1)
                    if (end < 0) output.append("\\[")
                    else {
                        var content = value.substring(index + 1, end)
                        val negated = content.startsWith('!') || content.startsWith('^')
                        if (negated) content = content.drop(1)
                        output.append('[').append(if (negated) "^" else "")
                            .append(content.replace("\\", "\\\\")).append(']')
                        index = end
                    }
                }
                '\\' -> {
                    if (index + 1 < value.length) {
                        index++
                        output.append(Regex.escape(value[index].toString()))
                    } else output.append("\\\\")
                }
                else -> output.append(Regex.escape(char.toString()))
            }
            index++
        }
        output.append('$')
        return Regex(output.toString())
    }

    private fun normalize(path: String): String = path.replace('\\', '/').removePrefix("./").trim('/')
}
