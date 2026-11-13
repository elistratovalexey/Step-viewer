package com.stepviewer

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.IOException

// Отдаёт файлы из assets/viewer с правильными MIME-типами (важно для .wasm и ES-модулей).
class ViewerAssetsHandler(private val context: Context) : WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse? {
        val clean = path.trimStart('/').substringBefore('?')
        if (clean.isEmpty() || clean.contains("..")) return null
        return try {
            val stream = context.assets.open("viewer/$clean")
            val text = clean.substringAfterLast('.', "").lowercase() !in setOf("wasm", "png", "jpg", "ico")
            WebResourceResponse(mime(clean), if (text) "UTF-8" else null, stream).apply {
                responseHeaders = mapOf(
                    "Access-Control-Allow-Origin" to "*",
                    "Cache-Control" to "no-store"
                )
            }
        } catch (e: IOException) {
            null
        }
    }

    private fun mime(p: String) = when (p.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "wasm" -> "application/wasm"
        "json", "map" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        else -> "application/octet-stream"
    }
}

// Стримит выбранный пользователем файл прямо в WebView, без копирования и base64.
class ModelPathHandler(private val resolver: ContentResolver) : WebViewAssetLoader.PathHandler {
    @Volatile var uri: Uri? = null

    override fun handle(path: String): WebResourceResponse? {
        val u = uri ?: return null
        return try {
            val input = resolver.openInputStream(u) ?: return null
            WebResourceResponse("application/octet-stream", null, input).apply {
                responseHeaders = mapOf(
                    "Access-Control-Allow-Origin" to "*",
                    "Cache-Control" to "no-store"
                )
            }
        } catch (e: Exception) {
            null
        }
    }
}
