package com.stepviewer

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var toolbar: Toolbar
    private lateinit var loading: View
    private lateinit var status: TextView
    private lateinit var empty: View
    private lateinit var bottom: View
    private lateinit var modelHandler: ModelPathHandler

    private var ready = false
    private var pending: Uri? = null
    private var current: Uri? = null
    private var fileName = ""
    private var fileSize = 0L

    private var names = arrayOf<String>()
    private var visible = booleanArrayOf()
    private var info = "Модель не загружена"

    private var wire = false
    private var edges = false
    private var ortho = false
    private var grid = false
    private var dark = true
    private var deflection = 0.001

    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        if (u != null) open(u)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        toolbar = findViewById(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.title = getString(R.string.app_name)

        loading = findViewById(R.id.loading)
        status = findViewById(R.id.status)
        empty = findViewById(R.id.empty)
        bottom = findViewById(R.id.bottomBar)

        modelHandler = ModelPathHandler(contentResolver)
        initWeb()

        findViewById<Button>(R.id.btnOpen).setOnClickListener { picker.launch(arrayOf("*/*")) }
        findViewById<Button>(R.id.btnFit).setOnClickListener { js("SV.fit()") }
        findViewById<Button>(R.id.btnIso).setOnClickListener { js("SV.setView('iso')") }
        findViewById<Button>(R.id.btnWire).setOnClickListener { toggleWire() }
        findViewById<Button>(R.id.btnEdges).setOnClickListener { toggleEdges() }
        findViewById<Button>(R.id.btnOrtho).setOnClickListener { toggleOrtho() }

        val saved = savedInstanceState?.getString("uri")
        if (saved != null) open(Uri.parse(saved)) else handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        if (i?.action == Intent.ACTION_VIEW) i.data?.let { open(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        current?.let { outState.putString("uri", it.toString()) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWeb() {
        web = findViewById(R.id.web)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/viewer/", ViewerAssetsHandler(this))
            .addPathHandler("/model/", modelHandler)
            .build()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest) =
                loader.shouldInterceptRequest(r.url)

            override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean {
                Toast.makeText(this@MainActivity,
                    "Не хватило памяти для модели. Попробуйте качество «Быстро».",
                    Toast.LENGTH_LONG).show()
                recreate()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("StepViewer", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        web.loadUrl("https://appassets.androidplatform.net/viewer/index.html")
    }

    private inner class Bridge {
        @JavascriptInterface
        fun post(json: String) = runOnUiThread { onEvent(json) }
    }

    private fun onEvent(json: String) {
        val o = JSONObject(json)
        when (o.optString("type")) {
            "ready" -> {
                ready = true
                pushSettings()
                pending?.let { pending = null; startLoad(it) }
            }
            "status" -> status.text = o.optString("text")
            "toast" -> Toast.makeText(this, o.optString("text"), Toast.LENGTH_SHORT).show()
            "loaded" -> {
                loading.visibility = View.GONE
                empty.visibility = View.GONE
                bottom.visibility = View.VISIBLE
                val arr = o.optJSONArray("parts") ?: JSONArray()
                names = Array(arr.length()) { i -> arr.optString(i).ifBlank { "Деталь ${i + 1}" } }
                visible = BooleanArray(names.size) { true }
                val b = o.optJSONArray("bbox") ?: JSONArray()
                fun d(i: Int) = b.optDouble(i, 0.0)
                info = buildString {
                    append("Файл: ").append(fileName).append('\n')
                    append("Размер: ").append(fmt(fileSize / 1048576.0)).append(" МБ\n")
                    append("Деталей: ").append(names.size).append('\n')
                    append("Треугольников: ").append(o.optInt("triangles")).append('\n')
                    append("Габариты, мм: ")
                        .append(fmt(d(0))).append(" × ").append(fmt(d(1))).append(" × ").append(fmt(d(2))).append('\n')
                    append("Время загрузки: ").append(fmt(o.optDouble("time") / 1000.0)).append(" с")
                }
                supportActionBar?.title = fileName
                supportActionBar?.subtitle = "${names.size} дет. · ${o.optInt("triangles")} треуг."
            }
            "error" -> {
                loading.visibility = View.GONE
                if (names.isEmpty()) empty.visibility = View.VISIBLE
                AlertDialog.Builder(this).setTitle("Ошибка")
                    .setMessage(o.optString("text")).setPositiveButton("OK", null).show()
            }
        }
    }

    private fun fmt(v: Double) = String.format(Locale.US, "%.2f", v)

    private fun open(u: Uri) {
        try {
            contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {}
        current = u
        val meta = query(u)
        fileName = meta.first
        fileSize = meta.second
        names = arrayOf(); visible = booleanArrayOf()
        empty.visibility = View.GONE
        bottom.visibility = View.GONE
        loading.visibility = View.VISIBLE
        status.text = "Открываю…"
        supportActionBar?.title = fileName
        supportActionBar?.subtitle = null
        js("SV.clear()")
        if (ready) startLoad(u) else pending = u
    }

    private fun startLoad(u: Uri) {
        modelHandler.uri = u
        val url = "https://appassets.androidplatform.net/model/model.bin?v=${System.currentTimeMillis()}"
        js("SV.open(${JSONObject.quote(url)}, ${JSONObject.quote(fileName)})")
    }

    private fun query(u: Uri): Pair<String, Long> {
        var name = "model.step"; var size = 0L
        try {
            contentResolver.query(u, null, null, null, null)?.use { c ->
                val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val si = c.getColumnIndex(OpenableColumns.SIZE)
                if (c.moveToFirst()) {
                    if (ni >= 0) c.getString(ni)?.let { name = it }
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        } catch (_: Exception) {}
        return name to size
    }

    private fun js(code: String) = web.evaluateJavascript("window.SV && ($code)", null)

    private fun pushSettings() = js(
        "SV.setWireframe($wire), SV.setEdges($edges), SV.setOrtho($ortho), " +
        "SV.setGrid($grid), SV.setDark($dark), SV.setQuality($deflection)"
    )

    private fun toggleWire() { wire = !wire; js("SV.setWireframe($wire)"); invalidateOptionsMenu() }
    private fun toggleEdges() { edges = !edges; js("SV.setEdges($edges)"); invalidateOptionsMenu() }
    private fun toggleOrtho() { ortho = !ortho; js("SV.setOrtho($ortho)"); invalidateOptionsMenu() }

    private fun pushVisibility() {
        val a = JSONArray()
        visible.forEach { a.put(it) }
        js("SV.setPartsVisible($a)")
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(R.id.action_wire)?.isChecked = wire
        menu.findItem(R.id.action_edges)?.isChecked = edges
        menu.findItem(R.id.action_ortho)?.isChecked = ortho
        menu.findItem(R.id.action_grid)?.isChecked = grid
        menu.findItem(R.id.action_dark)?.isChecked = dark
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_open -> picker.launch(arrayOf("*/*"))
            R.id.action_fit -> js("SV.fit()")
            R.id.view_iso -> js("SV.setView('iso')")
            R.id.view_front -> js("SV.setView('front')")
            R.id.view_back -> js("SV.setView('back')")
            R.id.view_top -> js("SV.setView('top')")
            R.id.view_bottom -> js("SV.setView('bottom')")
            R.id.view_right -> js("SV.setView('right')")
            R.id.view_left -> js("SV.setView('left')")
            R.id.action_wire -> toggleWire()
            R.id.action_edges -> toggleEdges()
            R.id.action_ortho -> toggleOrtho()
            R.id.action_grid -> { grid = !grid; js("SV.setGrid($grid)") }
            R.id.action_dark -> { dark = !dark; js("SV.setDark($dark)") }
            R.id.action_parts -> partsDialog()
            R.id.action_info -> AlertDialog.Builder(this).setTitle("Свойства модели")
                .setMessage(info).setPositiveButton("OK", null).show()
            R.id.q_low, R.id.q_mid, R.id.q_high -> {
                item.isChecked = true
                deflection = when (item.itemId) {
                    R.id.q_low -> 0.005
                    R.id.q_high -> 0.0003
                    else -> 0.001
                }
                js("SV.setQuality($deflection)")
                current?.let { open(it) }
            }
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun partsDialog() {
        if (names.isEmpty()) {
            Toast.makeText(this, "Модель не загружена", Toast.LENGTH_SHORT).show(); return
        }
        AlertDialog.Builder(this)
            .setTitle("Детали (${names.size})")
            .setMultiChoiceItems(names, visible) { _, i, checked ->
                visible[i] = checked; pushVisibility()
            }
            .setNeutralButton("Показать все") { _, _ ->
                for (i in visible.indices) visible[i] = true
                pushVisibility()
            }
            .setPositiveButton("Готово", null)
            .show()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
