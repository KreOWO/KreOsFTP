package com.kreos.ftp.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FtpIgnoreTest {
    private val ignore = FtpIgnore(
        """
        /.git/
        **/__pycache__/
        *.log
        *.py[cod]
        .env.*
        !.env.example
        /app/data/
        """.trimIndent()
    )

    @Test fun rootAndNestedRulesWork() {
        assertTrue(ignore.ignores(".git", true))
        assertTrue(ignore.ignores("pkg/__pycache__", true))
        assertTrue(ignore.ignores("pkg/debug.log", false))
        assertTrue(ignore.ignores("module.pyc", false))
        assertTrue(ignore.ignores("app/data/database.db", false))
        assertFalse(ignore.ignores("nested/.git", true))
        assertFalse(ignore.ignores(".env.example", false))
    }

    @Test fun controlFileCanNeverBeIncluded() {
        val rules = FtpIgnore("!.ftpignore")
        assertTrue(rules.ignores(".ftpignore", false))
        assertTrue(rules.ignores("nested/.ftpignore", false))
    }
}
