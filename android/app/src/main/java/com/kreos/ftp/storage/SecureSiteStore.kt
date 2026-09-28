package com.kreos.ftp.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.kreos.ftp.model.Protocol
import com.kreos.ftp.model.SiteProfile
import com.kreos.ftp.model.TerminalHotkey
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Profiles live only in app-private preferences; passwords are AES-GCM encrypted by Android Keystore. */
class SecureSiteStore(context: Context) {
    private val preferences = context.getSharedPreferences("sites", Context.MODE_PRIVATE)
    private val alias = "kreosftp.profile.passwords.v1"

    fun list(): List<SiteProfile> {
        val raw = preferences.getString("profiles", "[]") ?: "[]"
        val array = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        return buildList {
            for (index in 0 until array.length()) {
                runCatching { decode(array.getJSONObject(index)) }.getOrNull()?.let(::add)
            }
        }
    }

    fun save(profile: SiteProfile) {
        val profiles = list().toMutableList()
        val index = profiles.indexOfFirst { it.id == profile.id }
        if (index >= 0) profiles[index] = profile else profiles += profile
        persist(profiles)
    }

    fun delete(id: String) {
        persist(list().filterNot { it.id == id })
        preferences.edit().remove("hotkeys.$id").apply()
    }

    fun hotkeys(profileId: String): List<TerminalHotkey> {
        val encrypted = preferences.getString("hotkeys.$profileId", null) ?: return emptyList()
        val raw = runCatching { decrypt(encrypted) }.getOrNull() ?: return emptyList()
        val array = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        return buildList {
            for (index in 0 until array.length()) {
                runCatching {
                    val item = array.getJSONObject(index)
                    TerminalHotkey(
                        id = item.getString("id"),
                        label = item.getString("label"),
                        payload = item.getString("payload"),
                        keyCode = item.optInt("keyCode", -1).takeIf { it >= 0 },
                        ctrl = item.optBoolean("ctrl"),
                        alt = item.optBoolean("alt"),
                        shift = item.optBoolean("shift")
                    )
                }.getOrNull()?.let(::add)
            }
        }
    }

    fun saveHotkeys(profileId: String, hotkeys: List<TerminalHotkey>) {
        val array = JSONArray()
        hotkeys.forEach { hotkey ->
            array.put(JSONObject().apply {
                put("id", hotkey.id)
                put("label", hotkey.label)
                put("payload", hotkey.payload)
                hotkey.keyCode?.let { put("keyCode", it) }
                put("ctrl", hotkey.ctrl)
                put("alt", hotkey.alt)
                put("shift", hotkey.shift)
            })
        }
        preferences.edit().putString("hotkeys.$profileId", encrypt(array.toString())).apply()
    }

    fun selectedId(): String? = preferences.getString("selected", null)

    fun select(id: String?) {
        preferences.edit().apply {
            if (id == null) remove("selected") else putString("selected", id)
        }.apply()
    }

    fun localTreeUri(): String? = preferences.getString("localTree", null)

    fun localTreeUri(uri: String) {
        preferences.edit().putString("localTree", uri).apply()
    }

    private fun persist(profiles: List<SiteProfile>) {
        val array = JSONArray()
        profiles.forEach { array.put(encode(it)) }
        preferences.edit().putString("profiles", array.toString()).apply()
    }

    private fun encode(profile: SiteProfile): JSONObject = JSONObject().apply {
        put("id", profile.id)
        put("name", profile.name)
        put("protocol", profile.protocol.name)
        put("host", profile.host)
        put("port", profile.port)
        put("username", profile.username)
        put("password", encrypt(profile.password))
        put("remotePath", profile.remotePath)
        put("sshPort", profile.sshPort)
        profile.hostKeyFingerprint?.let { put("hostKey", it) }
    }

    private fun decode(value: JSONObject): SiteProfile = SiteProfile(
        id = value.getString("id"),
        name = value.getString("name"),
        protocol = Protocol.valueOf(value.getString("protocol")),
        host = value.getString("host"),
        port = value.getInt("port"),
        username = value.getString("username"),
        password = decrypt(value.getString("password")),
        remotePath = value.optString("remotePath", "/"),
        sshPort = value.optInt("sshPort", 22).takeIf { it in 1..65535 } ?: 22,
        hostKeyFingerprint = value.optString("hostKey").takeIf(String::isNotBlank)
    )

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            generateKey()
        }
    }

    private fun encrypt(value: String): String {
        if (value.isEmpty()) return ""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertext = Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
        return "$iv:$ciphertext"
    }

    private fun decrypt(value: String): String {
        if (value.isBlank()) return ""
        val parts = value.split(':', limit = 2)
        require(parts.size == 2) { "Некорректная запись пароля" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
        )
        return cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }
}
