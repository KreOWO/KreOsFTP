package com.kreos.ftp.protocol

import android.util.Base64
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import com.kreos.ftp.model.SiteProfile
import java.security.MessageDigest

/** Creates SSH sessions with strict, profile-pinned host-key verification. */
object SshSessionFactory {
    fun connect(profile: SiteProfile, port: Int): Session {
        val repository = PinnedHostKeyRepository(profile.hostKeyFingerprint)
        val session = JSch().apply { hostKeyRepository = repository }
            .getSession(profile.username, profile.host, port)
        val password = profile.password.toByteArray(Charsets.UTF_8)
        try {
            session.setPassword(password)
        } finally {
            password.fill(0)
        }
        session.setConfig("StrictHostKeyChecking", "yes")
        session.setConfig("PreferredAuthentications", "password,keyboard-interactive")
        session.timeout = 20_000
        session.setServerAliveInterval(15_000)
        session.setServerAliveCountMax(3)
        try {
            session.connect(15_000)
            return session
        } catch (error: JSchException) {
            session.disconnect()
            val actual = repository.seenFingerprint
            if (actual != null && profile.hostKeyFingerprint == null) {
                throw HostKeyApprovalRequired(actual)
            }
            if (actual != null && profile.hostKeyFingerprint != actual) {
                throw HostKeyMismatch(profile.hostKeyFingerprint.orEmpty(), actual)
            }
            throw error
        }
    }
}

private class PinnedHostKeyRepository(private val expected: String?) : HostKeyRepository {
    var seenFingerprint: String? = null
        private set

    override fun check(host: String?, key: ByteArray?): Int {
        if (key == null) return HostKeyRepository.NOT_INCLUDED
        val fingerprint = "SHA256:" + Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(key),
            Base64.NO_WRAP or Base64.NO_PADDING
        )
        seenFingerprint = fingerprint
        return when {
            expected == null -> HostKeyRepository.NOT_INCLUDED
            expected == fingerprint -> HostKeyRepository.OK
            else -> HostKeyRepository.CHANGED
        }
    }

    override fun add(hostkey: HostKey?, ui: UserInfo?) = Unit
    override fun remove(host: String?, type: String?) = Unit
    override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
    override fun getKnownHostsRepositoryID(): String = "KreOsFTP pinned keys"
    override fun getHostKey(): Array<HostKey> = emptyArray()
    override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
}
