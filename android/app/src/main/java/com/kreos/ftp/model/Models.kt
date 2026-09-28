package com.kreos.ftp.model

import java.util.UUID

enum class Protocol(val defaultPort: Int) {
    FTP(21),
    FTPS(21),
    SFTP(22)
}

data class SiteProfile(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val protocol: Protocol,
    val host: String,
    val port: Int = protocol.defaultPort,
    val username: String,
    val password: String,
    val remotePath: String = "/",
    val sshPort: Int = 22,
    val hostKeyFingerprint: String? = null
)

data class TerminalHotkey(
    val id: String = UUID.randomUUID().toString(),
    val label: String,
    val payload: String,
    val keyCode: Int? = null,
    val ctrl: Boolean = false,
    val alt: Boolean = false,
    val shift: Boolean = false
)

data class RemoteEntry(
    val name: String,
    val path: String,
    val directory: Boolean,
    val size: Long,
    val modifiedAt: Long?
)

data class TransferState(
    val label: String,
    val transferred: Long,
    val total: Long?,
    val finished: Boolean = false,
    val error: String? = null
)

sealed interface SyncAction {
    val relativePath: String
    val size: Long

    data class Upload(
        override val relativePath: String,
        val localUri: String,
        val remotePath: String,
        override val size: Long
    ) : SyncAction

    data class Download(
        override val relativePath: String,
        val remotePath: String,
        override val size: Long
    ) : SyncAction
}

data class SyncPlan(
    val actions: List<SyncAction>,
    val directories: List<String>,
    val ignored: Int,
    val unchanged: Int
)
