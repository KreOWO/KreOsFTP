package com.kreos.ftp.sync

import android.content.ContentResolver
import androidx.documentfile.provider.DocumentFile

object DocumentTrees {
    fun child(directory: DocumentFile, name: String): DocumentFile? =
        directory.listFiles().firstOrNull { it.name == name }

    fun resolve(root: DocumentFile, relative: String): DocumentFile? =
        relative.split('/').filter(String::isNotBlank).fold(root as DocumentFile?) { parent, name ->
            parent?.takeIf(DocumentFile::isDirectory)?.let { child(it, name) }
        }

    fun ensureDirectory(root: DocumentFile, relative: String): DocumentFile {
        var current = root
        relative.split('/').filter(String::isNotBlank).forEach { name ->
            val existing = child(current, name)
            current = when {
                existing == null -> current.createDirectory(name) ?: error("Не удалось создать папку $name")
                existing.isDirectory -> existing
                else -> error("Файл мешает создать папку $name")
            }
        }
        return current
    }

    fun ensureFile(root: DocumentFile, relative: String): DocumentFile {
        val parts = relative.split('/').filter(String::isNotBlank)
        require(parts.isNotEmpty()) { "Пустой путь файла" }
        val parent = ensureDirectory(root, parts.dropLast(1).joinToString("/"))
        val name = parts.last()
        val existing = child(parent, name)
        if (existing != null) {
            check(existing.isFile) { "Папка мешает записать файл $relative" }
            return existing
        }
        return parent.createFile("application/octet-stream", name)
            ?: error("Не удалось создать файл $relative")
    }

    fun readText(resolver: ContentResolver, file: DocumentFile, limit: Int = 1024 * 1024): String {
        check(file.length() <= limit) { ".ftpignore больше 1 МБ" }
        return resolver.openInputStream(file.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            ?: error("Не удалось прочитать ${file.name}")
    }
}
