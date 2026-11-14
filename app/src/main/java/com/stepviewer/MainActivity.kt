package com.stepviewer

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var toolbar: Toolbar
    private lateinit var loading: View
    private lateinit var status: TextView
    private lateinit var empty: View
    private lateinit var deck: View
    private lateinit var hint: TextView
    private lateinit var bWire: Button
    private lateinit var bEdges: Button
    private lateinit var bOrtho: Button
    private lateinit var bGrid: Button
    private lateinit var bModeSelect: Button
    private lateinit var bModeMeasure: Button
    private lateinit var secX: Button
    private lateinit var secY: Button
    private lateinit var secZ: Button
    private lateinit var secEnable: Button
    private lateinit var secFlip: Button
    private lateinit var secShow: Button
    private lateinit var secSeek: SeekBar
    private lateinit var bMeasList: Button
    private lateinit var modelHandler: ModelPathHandler

    private var ready = false
    private var pending: Uri? = null
    private var current: Uri? = null
    private var fileName = ""
    private var fileSize = 0L
    private var names = arrayOf<String>()
    private var visible = booleanArrayOf()
    private var info = "Модель не загружена"
    private var stats = ""
    private var selIndex = -1
    private var selName = ""
    private var mode = "select"
    private var wire = false
    private var edges = false
    private var ortho = false
    private var grid = false
    private var dark = true
    private var deflection = 0.001
    private var latestState = ""
    private var measList = JSONArray()
    private var stlBuf = ByteArrayOutputStream()
    private var stlBytes = ByteArray(0)
    private var stepBuf = ByteArrayOutputStream()
    private var stepBytes = ByteArray(0)
    private val handler = Handler(Looper.getMainLooper())
    private var autosave: Runnable? = null
    private val secState = JSONObject("""{"show":true,"axis":"x","x":{"on":false,"off":0,"flip":false},"y":{"on":false,"off":0,"flip":false},"z":{"on":false,"off":0,"flip":false}}""")

    private val palette = arrayOf(
        "Стальной" to "#9fb0c0", "Красный" to "#e53935", "Оранжевый" to "#fb8c00",
        "Жёлтый" to "#fdd835", "Зелёный" to "#43a047", "Бирюзовый" to "#00acc1",
        "Синий" to "#1e88e5", "Фиолетовый" to "#8e24aa", "Белый" to "#f5f5f5", "Тёмно-серый" to "#455a64"
    )

    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { u -> if (u != null) open(u) }
    private val saveProject = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { u ->
        if (u != null) writeText(u, latestState.ifBlank { "{}" })
    }
    private val loadProject = registerForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        if (u != null) readText(u)?.let { js("SV.applyState($it)") }
    }
    private val saveStl = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { u ->
        if (u != null && stlBytes.isNotEmpty()) writeBytes(u, stlBytes, "STL")
    }
    private val saveStep = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { u ->
        if (u != null && stepBytes.isNotEmpty()) writeBytes(u, stepBytes, "STEP")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        toolbar = findViewById(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.title = getString(R.string.app_name)
        supportActionBar?.subtitle = "версия ${BuildConfig.VERSION_NAME}"
        loading = findViewById(R.id.loading)
        status = findViewById(R.id.status)
        empty = findViewById(R.id.empty)
        deck = findViewById(R.id.deck)
        hint = findViewById(R.id.measureHint)
        bWire = findViewById(R.id.btnWire)
        bEdges = findViewById(R.id.btnEdges)
        bOrtho = findViewById(R.id.btnOrtho)
        bGrid = findViewById(R.id.btnGrid)
        bModeSelect = findViewById(R.id.modeSelect)
        bModeMeasure = findViewById(R.id.modeMeasure)
        secX = findViewById(R.id.secAxisX)
        secY = findViewById(R.id.secAxisY)
        secZ = findViewById(R.id.secAxisZ)
        secEnable = findViewById(R.id.secEnable)
        secFlip = findViewById(R.id.secFlip)
        secShow = findViewById(R.id.secShow)
        secSeek = findViewById(R.id.secSeek)
        bMeasList = findViewById(R.id.btnMeasList)
        modelHandler = ModelPathHandler(contentResolver)
        initWeb()
        wireUi()
        val saved = savedInstanceState?.getString("uri")
        if (saved != null) open(Uri.parse(saved)) else handleIntent(intent)
    }

    private fun wireUi() {
        findViewById<Button>(R.id.btnOpen).setOnClickListener { picker.launch(arrayOf("*/*")) }
        findViewById<Button>(R.id.btnFit).setOnClickListener { js("SV.fit()") }
        findViewById<Button>(R.id.btnIso).setOnClickListener { js("SV.setView('iso')") }
        bWire.setOnClickListener { toggleWire() }
        bEdges.setOnClickListener { toggleEdges() }
        bOrtho.setOnClickListener { toggleOrtho() }
        bGrid.setOnClickListener { grid = !grid; js("SV.setGrid($grid)"); updateDeck() }
        bModeSelect.setOnClickListener { setMode("select") }
        bModeMeasure.setOnClickListener { setMode("measure") }
        secX.setOnClickListener { setAxis("x") }
        secY.setOnClickListener { setAxis("y") }
        secZ.setOnClickListener { setAxis("z") }
        secEnable.setOnClickListener { val a = secState.optString("axis"); val o = secState.getJSONObject(a); o.put("on", !o.optBoolean("on")); pushSection() }
        secFlip.setOnClickListener { val a = secState.optString("axis"); val o = secState.getJSONObject(a); o.put("flip", !o.optBoolean("flip")); pushSection() }
        secShow.setOnClickListener { secState.put("show", !secState.optBoolean("show")); pushSection() }
        secSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, p: Int, fromUser: Boolean) {
                if (!fromUser) return
                val a = secState.optString("axis")
                secState.getJSONObject(a).put("off", (p - 100) / 100.0)
                pushSection()
            }
            override fun onStartTrackingTouch(sb: SeekBar) {}
            override fun onStopTrackingTouch(sb: SeekBar) {}
        })
        bMeasList.setOnClickListener { measuresDialog() }
        findViewById<Button>(R.id.btnMeasClear).setOnClickListener { js("SV.clearMeasures()") }
        findViewById<Button>(R.id.btnSave).setOnClickListener { js("SV.requestState()"); saveProject.launch(baseName() + ".stepview.json") }
        findViewById<Button>(R.id.btnStep).setOnClickListener { stepBuf = ByteArrayOutputStream(); stepBytes = ByteArray(0); js("SV.exportStepEdited()") }
        findViewById<Button>(R.id.btnExport).setOnClickListener { stlBuf = ByteArrayOutputStream(); stlBytes = ByteArray(0); js("SV.exportSTL()") }
        updateDeck(); updateSectionUi()
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleIntent(intent) }
    private fun handleIntent(i: Intent?) { if (i?.action == Intent.ACTION_VIEW) i.data?.let { open(it) } }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); current?.let { outState.putString("uri", it.toString()) } }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWeb() {
        web = findViewById(R.id.web)
        val loader = WebViewAssetLoader.Builder().addPathHandler("/viewer/", ViewerAssetsHandler(this)).addPathHandler("/model/", modelHandler).build()
        with(web.settings) {
            javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false; allowContentAccess = false
            setSupportZoom(false); builtInZoomControls = false; useWideViewPort = true; loadWithOverviewMode = true; cacheMode = WebSettings.LOAD_NO_CACHE
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest) = loader.shouldInterceptRequest(r.url)
            override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean {
                Toast.makeText(this@MainActivity, "Не хватило памяти. Попробуйте качество «Быстро».", Toast.LENGTH_LONG).show(); recreate(); return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.d("StepViewer", "${m.message()} (${m.sourceId()}:${m.lineNumber()})"); return true }
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        web.loadUrl("https://appassets.androidplatform.net/viewer/index.html")
    }

    private inner class Bridge { @JavascriptInterface fun post(json: String) = runOnUiThread { onEvent(json) } }

    private fun onEvent(json: String) {
        val o = JSONObject(json)
        when (o.optString("type")) {
            "ready" -> { ready = true; pushSettings(); pending?.let { pending = null; startLoad(it) } }
            "status" -> status.text = o.optString("text")
            "toast" -> Toast.makeText(this, o.optString("text"), Toast.LENGTH_SHORT).show()
            "measureHint" -> { hint.text = o.optString("text"); hint.visibility = if (mode == "measure" && o.optString("text").isNotEmpty()) View.VISIBLE else View.GONE }
            "select" -> { selIndex = o.optInt("index", -1); selName = o.optString("name"); supportActionBar?.subtitle = "▣ $selName"; if (selIndex >= 0) selectionDialog() }
            "deselect" -> { selIndex = -1; selName = ""; supportActionBar?.subtitle = stats }
            "measures" -> { measList = o.optJSONArray("list") ?: JSONArray(); bMeasList.text = "Измерения (${measList.length()})" }
            "state" -> { latestState = o.optJSONObject("state")?.toString() ?: ""; scheduleAutosave() }
            "stlChunk" -> { if (o.optInt("seq") == 0) stlBuf = ByteArrayOutputStream(); stlBuf.write(Base64.decode(o.optString("data"), Base64.DEFAULT)) }
            "stlDone" -> { stlBytes = stlBuf.toByteArray(); saveStl.launch(baseName() + ".stl") }
            "stepChunk" -> { if (o.optInt("seq") == 0) stepBuf = ByteArrayOutputStream(); stepBuf.write(Base64.decode(o.optString("data"), Base64.DEFAULT)) }
            "stepDone" -> {
                stepBytes = stepBuf.toByteArray()
                Toast.makeText(this, "STEP подготовлен: цветов записано ${o.optInt("matched")}", Toast.LENGTH_SHORT).show()
                saveStep.launch(baseName() + "_edited.step")
            }
            "loaded" -> {
                loading.visibility = View.GONE; empty.visibility = View.GONE; deck.visibility = View.VISIBLE
                selIndex = -1
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
                    append("Габариты, мм: ").append(fmt(d(0))).append(" × ").append(fmt(d(1))).append(" × ").append(fmt(d(2))).append('\n')
                    append("Время загрузки: ").append(fmt(o.optDouble("time") / 1000.0)).append(" с")
                }
                stats = "${names.size} дет. · ${o.optInt("triangles")} треуг."
                supportActionBar?.title = fileName; supportActionBar?.subtitle = stats
                updateDeck()
                loadInternalProject()
            }
            "error" -> { loading.visibility = View.GONE; if (names.isEmpty()) empty.visibility = View.VISIBLE; AlertDialog.Builder(this).setTitle("Ошибка").setMessage(o.optString("text")).setPositiveButton("OK", null).show() }
        }
    }

    private fun fmt(v: Double) = String.format(Locale.US, "%.2f", v)
    private fun baseName() = fileName.substringBeforeLast('.', "model")

    private fun open(u: Uri) {
        try { contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        current = u
        val meta = query(u); fileName = meta.first; fileSize = meta.second
        names = arrayOf(); visible = booleanArrayOf(); selIndex = -1; stats = ""; measList = JSONArray()
        empty.visibility = View.GONE; deck.visibility = View.GONE; loading.visibility = View.VISIBLE
        status.text = "Открываю…"; supportActionBar?.title = fileName; supportActionBar?.subtitle = null
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
                val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME); val si = c.getColumnIndex(OpenableColumns.SIZE)
                if (c.moveToFirst()) { if (ni >= 0) c.getString(ni)?.let { name = it }; if (si >= 0 && !c.isNull(si)) size = c.getLong(si) }
            }
        } catch (_: Exception) {}
        return name to size
    }

    private fun js(code: String) = web.evaluateJavascript("window.SV && ($code)", null)
    private fun pushSettings() = js("SV.setWireframe($wire), SV.setEdges($edges), SV.setOrtho($ortho), SV.setGrid($grid), SV.setDark($dark), SV.setQuality($deflection), SV.setMode(${JSONObject.quote(mode)}), SV.setSection($secState)")

    private fun chip(b: Button, on: Boolean, accent: Int = 0xFF1E88E5.toInt()) {
        b.setBackgroundColor(if (on) accent else 0x00000000)
        b.setTextColor(if (on) 0xFFFFFFFF.toInt() else 0xFF90A4AE.toInt())
        b.setTypeface(null, if (on) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
    }


    private fun updateDeck() {
        chip(bModeSelect, mode == "select"); chip(bModeMeasure, mode == "measure", 0xFFF59E0B.toInt())
        chip(bWire, wire); chip(bEdges, edges); chip(bOrtho, ortho); chip(bGrid, grid)
    }
    private fun setMode(m: String) { mode = m; js("SV.setMode(${JSONObject.quote(m)})"); hint.visibility = if (m == "measure") View.VISIBLE else View.GONE; if (m == "measure") hint.text = "Тапните первую точку"; updateDeck() }
    private fun toggleWire() { wire = !wire; js("SV.setWireframe($wire)"); updateDeck(); invalidateOptionsMenu() }
    private fun toggleEdges() { edges = !edges; js("SV.setEdges($edges)"); updateDeck(); invalidateOptionsMenu() }
    private fun toggleOrtho() { ortho = !ortho; js("SV.setOrtho($ortho)"); updateDeck(); invalidateOptionsMenu() }

    private fun setAxis(a: String) { secState.put("axis", a); pushSection() }
    private fun pushSection() { js("SV.setSection($secState)"); updateSectionUi() }
    private fun updateSectionUi() {
        val a = secState.optString("axis"); val o = secState.getJSONObject(a)
        chip(secX, a == "x", 0xFFF43F5E.toInt()); chip(secY, a == "y", 0xFFF43F5E.toInt()); chip(secZ, a == "z", 0xFFF43F5E.toInt())
        chip(secEnable, o.optBoolean("on"), 0xFFF43F5E.toInt()); chip(secFlip, o.optBoolean("flip"), 0xFFF43F5E.toInt()); chip(secShow, secState.optBoolean("show"), 0xFFF43F5E.toInt())
        secSeek.progress = ((o.optDouble("off") * 100) + 100).toInt().coerceIn(0, 200)
    }

    private fun pushVisibility() { val a = JSONArray(); visible.forEach { a.put(it) }; js("SV.setPartsVisible($a)") }

    private fun selectionDialog() {
        if (selIndex < 0 || selIndex >= visible.size) return
        val actions = arrayOf("Изменить цвет", "Скрыть деталь", "Показать только её", "Показать все детали", "Снять выделение")
        AlertDialog.Builder(this).setTitle(selName).setItems(actions) { _, w ->
            when (w) {
                0 -> colorDialog()
                1 -> { visible[selIndex] = false; pushVisibility(); js("SV.clearSelection()") }
                2 -> { for (i in visible.indices) visible[i] = (i == selIndex); pushVisibility() }
                3 -> { for (i in visible.indices) visible[i] = true; pushVisibility() }
                4 -> js("SV.clearSelection()")
            }
        }.show()
    }
    private fun colorDialog() {
        AlertDialog.Builder(this).setTitle("Цвет: $selName").setItems(palette.map { it.first }.toTypedArray()) { _, w -> js("SV.setColor(${JSONObject.quote(palette[w].second)})") }.show()
    }
    private fun measuresDialog() {
        if (measList.length() == 0) { Toast.makeText(this, "Измерений пока нет. Включите режим «Измерение» и тапните две точки.", Toast.LENGTH_LONG).show(); return }
        val items = Array(measList.length()) { i -> val m = measList.getJSONObject(i); val d = m.optDouble("d"); "№${m.optInt("id")}  —  " + if (d >= 1000) fmt(d / 1000) + " м" else fmt(d) + " мм" }
        AlertDialog.Builder(this).setTitle("Измерения — тап для удаления").setItems(items) { _, w -> js("SV.deleteMeasure(${measList.getJSONObject(w).optInt("id")})") }
            .setNeutralButton("Очистить все") { _, _ -> js("SV.clearMeasures()") }.setPositiveButton("Закрыть", null).show()
    }

    private fun projectKey(): String {
        val s = (current?.toString() ?: "") + "|" + fileSize
        val md = MessageDigest.getInstance("SHA-1").digest(s.toByteArray())
        return md.joinToString("") { "%02x".format(it) }
    }
    private fun internalProject(): File { val d = File(filesDir, "projects"); d.mkdirs(); return File(d, projectKey() + ".json") }
    private fun scheduleAutosave() { autosave?.let { handler.removeCallbacks(it) }; val r = Runnable { try { internalProject().writeText(latestState) } catch (_: Exception) {} }; autosave = r; handler.postDelayed(r, 700) }
    private fun loadInternalProject() { try { val f = internalProject(); if (f.exists()) js("SV.applyState(${f.readText()})") } catch (_: Exception) {} }
    private fun writeText(u: Uri, s: String) { try { contentResolver.openOutputStream(u)?.use { it.write(s.toByteArray()) }; Toast.makeText(this, "Проект сохранён", Toast.LENGTH_SHORT).show() } catch (e: Exception) { Toast.makeText(this, "Ошибка сохранения: ${e.message}", Toast.LENGTH_LONG).show() } }
    private fun readText(u: Uri): String? = try { contentResolver.openInputStream(u)?.use { it.readBytes().toString(Charsets.UTF_8) } } catch (_: Exception) { null }
    private fun writeBytes(u: Uri, b: ByteArray, kind: String) { try { contentResolver.openOutputStream(u)?.use { it.write(b) }; Toast.makeText(this, "$kind сохранён (${b.size / 1048576} МБ)", Toast.LENGTH_SHORT).show() } catch (e: Exception) { Toast.makeText(this, "Ошибка экспорта: ${e.message}", Toast.LENGTH_LONG).show() } }

    override fun onCreateOptionsMenu(menu: Menu): Boolean { menuInflater.inflate(R.menu.main, menu); return true }
    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(R.id.action_wire)?.isChecked = wire; menu.findItem(R.id.action_edges)?.isChecked = edges
        menu.findItem(R.id.action_ortho)?.isChecked = ortho; menu.findItem(R.id.action_grid)?.isChecked = grid; menu.findItem(R.id.action_dark)?.isChecked = dark
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
            R.id.action_grid -> { grid = !grid; js("SV.setGrid($grid)"); updateDeck() }
            R.id.action_dark -> { dark = !dark; js("SV.setDark($dark)") }
            R.id.action_parts -> partsDialog()
            R.id.action_load_project -> loadProject.launch(arrayOf("application/json", "text/plain", "*/*"))
            R.id.action_reset -> { try { internalProject().delete() } catch (_: Exception) {}; js("SV.resetEdits()"); Toast.makeText(this, "Изменения сброшены", Toast.LENGTH_SHORT).show() }
            R.id.q_low, R.id.q_mid, R.id.q_high -> {
                item.isChecked = true
                deflection = when (item.itemId) { R.id.q_low -> 0.005; R.id.q_high -> 0.0003; else -> 0.001 }
                js("SV.setQuality($deflection)"); current?.let { open(it) }
            }
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }
    private fun partsDialog() {
        if (names.isEmpty()) { Toast.makeText(this, "Модель не загружена", Toast.LENGTH_SHORT).show(); return }
        AlertDialog.Builder(this).setTitle("Детали (${names.size})").setMultiChoiceItems(names, visible) { _, i, checked -> visible[i] = checked; pushVisibility() }
            .setNeutralButton("Показать все") { _, _ -> for (i in visible.indices) visible[i] = true; pushVisibility() }.setPositiveButton("Готово", null).show()
    }
    override fun onDestroy() { web.destroy(); super.onDestroy() }
}
