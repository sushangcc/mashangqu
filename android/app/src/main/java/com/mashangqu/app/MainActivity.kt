package com.mashangqu.app

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * 码上取 · WebView 外壳
 *
 * 设计思路：
 *   界面完全复用网页版（public/ 打包进 assets/www），因此外观与浏览器中
 *   完全一致（液态玻璃、底栏三页、深色主题、水滴动效全部保留），
 *   无需再用手写 View 绘制一套简陋界面。
 *
 *   原生能力仍由本工程提供，与 WebView 界面互不影响：
 *     - SmsReceiver     短信到达自动入库（需要短信权限）
 *     - MashangquWidget  2×2 桌面小组件
 *
 * 数据来源两种：
 *   1. 未配置服务地址时 → 加载本地 assets/www（可离线浏览，数据为本地缓存）
 *   2. 已配置服务地址时 → 加载 http://<地址>:8000（联网同步真实数据）
 *
 * 本地页面通过 window.__MASHANGQU_NATIVE__ 暴露原生设置入口，
 * 网页中「我的 → 设置」可回调打开原生配置对话框。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var webView: WebView
    private lateinit var statusBar: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs.get(this)
        setupSystemBars()
        buildUi()
        handleWidgetIntent(intent)
        requestPermissions()
    }

    /**
     * 系统栏配色跟随页面背景。
     *
     * 之前用主题蓝（#4F6BED）导致上下各出现一条蓝色横条，与网页内容不搭。
     * 现在改为与网页背景一致的浅灰 #EEF1F5 / 深色 #12161C，
     * 并根据深浅调整状态栏图标颜色，避免白底白字或深底深字。
     */
    private fun setupSystemBars() {
        val dark = isSystemDark()
        val bg = if (dark) 0xFF12161C.toInt() else 0xFFEEF1F5.toInt()

        window.statusBarColor = bg
        window.navigationBarColor = bg

        var flags = window.decorView.systemUiVisibility
        flags = if (dark) {
            flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
        } else {
            flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        }
        window.decorView.systemUiVisibility = flags
    }

    private fun isSystemDark(): Boolean {
        val mode = resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK
        return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            handleWidgetIntent(intent)
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    /** 桌面小组件带来的门店筛选意图：转成网页可识别的查询参数 */
    private fun handleWidgetIntent(intent: Intent?) {
        val kw = intent?.getStringExtra("filter_store_keyword")?.trim().orEmpty()
        if (kw.isBlank()) {
            loadApp()
            return
        }
        intent?.removeExtra("filter_store_keyword")
        loadApp(storeKeyword = kw)
    }

    // ================= UI =================

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFFEEF1F5.toInt())
        }

        // 顶部状态条：未配置时提示，配置后隐藏（网页版自带顶栏）
        statusBar = TextView(this).apply {
            text = "未配置服务地址，正在显示本地页面（点此设置）"
            textSize = 12f
            setTextColor(Color.WHITE)
            setBackgroundColor(0xFF4F6BED.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(8))
            visibility = View.GONE
            setOnClickListener { showSettingsDialog() }
        }
        root.addView(statusBar, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        webView = WebView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
            )
            setBackgroundColor(0xFFEEF1F5.toInt())
        }
        configureWebView()
        root.addView(webView)

        setContentView(root)
        updateStatusBar()
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // 网页用 localStorage 存缓存与离线队列
            allowFileAccess = true
            allowContentAccess = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            // 让页面按手机宽度缩放，与浏览器表现一致
            useWideViewPort = true
            loadWithOverviewMode = true
            // 页面以 file:// 加载，需允许其请求 http:// 服务端（混合内容）
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = true   // file:// 页面可发跨域请求
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = true
            // 本地字体、图片直接引用
            blockNetworkImage = false
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                // 只允许 file:// 与配置的服务器地址，其余交给系统浏览器
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("file://")) return false
                val server = serverUrl()
                if (server.isNotEmpty() && url.startsWith(server)) return false
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectNativeBridge()
            }
        }

        webView.addJavascriptInterface(NativeBridge(), "MashangquNative")
    }

    /**
     * 向网页注入原生桥接：
     *   1. 把服务地址与口令写入 localStorage，网页据此拼出 API 完整 URL
     *   2. 暴露 openSettings() 让网页能调起原生设置对话框
     */
    private fun injectNativeBridge() {
        val base = prefs.getString("base_url", "") ?: ""
        val token = prefs.getString("token", "") ?: ""
        // 用 JSON 序列化避免引号/反斜杠破坏脚本
        val baseJs = org.json.JSONObject.quote(base)
        val tokenJs = org.json.JSONObject.quote(token)

        val js = """
            (function(){
              try {
                localStorage.setItem('msq_server', $baseJs);
                localStorage.setItem('msq_token', $tokenJs);
              } catch (e) {}
              if (!window.__MASHANGQU_NATIVE__) {
                window.__MASHANGQU_NATIVE__ = {
                  openSettings: function(){ MashangquNative.openSettings(); },
                  isNative: true
                };
              }
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    /** 供网页调用的原生方法 */
    inner class NativeBridge {
        @android.webkit.JavascriptInterface
        fun openSettings() {
            runOnUiThread { showSettingsDialog() }
        }
    }

    /** 服务端根地址；未配置时返回空串 */
    private fun serverUrl(): String {
        val base = prefs.getString("base_url", "") ?: ""
        return if (base.isBlank()) "" else base.trimEnd('/')
    }

    /**
     * 加载界面。
     *
     * 始终从 APK 内置的 assets/www 加载页面 —— 这是离线可用的前提：
     * 无论服务器是否可达、是否断网，界面都能立刻打开。
     * 数据层由网页通过 localStorage.msq_server 拼出 API 地址去请求服务端，
     * 拿不到数据时走它自己的离线缓存与待同步队列。
     */
    private fun loadApp(storeKeyword: String? = null) {
        var target = "file:///android_asset/www/index.html"
        if (storeKeyword != null) {
            // file:// 下用 hash 传参，避免被当作文件名
            target += "#store=" + android.net.Uri.encode(storeKeyword)
        }
        webView.loadUrl(target)
        updateStatusBar()
    }

    private fun updateStatusBar() {
        val configured = (prefs.getString("base_url", "") ?: "").isNotBlank()
        statusBar.visibility = if (configured) View.GONE else View.VISIBLE
    }

    // ================= 设置对话框 =================

    private fun showSettingsDialog() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(12), dp(20), 0)
        }

        root.addView(TextView(this).apply {
            text = "服务地址（家里电脑或服务器的地址）"
            textSize = 13f
            setTextColor(0xFF6B7887.toInt())
        })
        val urlE = EditText(this).apply {
            hint = "http://192.168.1.129:8000"
            setText(prefs.getString("base_url", ""))
            setPadding(0, dp(8), 0, dp(4))
        }
        root.addView(urlE)

        root.addView(TextView(this).apply {
            text = "访问口令"
            textSize = 13f
            setTextColor(0xFF6B7887.toInt())
            setPadding(0, dp(10), 0, 0)
        })
        val tokenE = EditText(this).apply {
            hint = "如 1234"
            setText(prefs.getString("token", ""))
            setPadding(0, dp(8), 0, dp(4))
        }
        root.addView(tokenE)

        val testBtn = Button(this).apply {
            text = "测试连接"
            setOnClickListener {
                val base = urlE.text.toString().trim().trimEnd('/')
                val token = tokenE.text.toString().trim()
                if (base.isBlank() || token.isBlank()) {
                    toast("请先填写地址和口令")
                    return@setOnClickListener
                }
                toast("连接中…")
                Thread {
                    try {
                        val s = ApiClient.testConnection(base, token)
                        runOnUiThread { toast("连接成功，待取 ${s.pending} 个") }
                    } catch (e: Exception) {
                        runOnUiThread { toast("连接失败：${e.message}") }
                    }
                }.start()
            }
        }
        root.addView(testBtn)

        val dialog = AlertDialog.Builder(this)
            .setTitle("设置")
            .setView(root)
            .setPositiveButton("保存", null)
            .setNeutralButton("短信权限") { _, _ -> requestPermissions() }
            .setNegativeButton("取消", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val base = urlE.text.toString().trim().trimEnd('/')
                val token = tokenE.text.toString().trim()
                if (base.isBlank() || token.isBlank()) {
                    toast("请填写服务地址和口令")
                    return@setOnClickListener
                }
                prefs.edit().putString("base_url", base).putString("token", token).apply()
                dialog.dismiss()
                toast("设置已保存")
                loadApp()
            }
        }
        dialog.show()
    }

    // ================= 权限 =================

    private fun requestPermissions() {
        val need = mutableListOf<String>()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) need.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (prefs.getBoolean("sms_auto", true)) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS)
                != PackageManager.PERMISSION_GRANTED
            ) need.add(Manifest.permission.RECEIVE_SMS)
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS)
                != PackageManager.PERMISSION_GRANTED
            ) need.add(Manifest.permission.READ_SMS)
        }

        if (need.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, need.toTypedArray(), 100)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100) {
            val smsGranted = permissions.indices.any { i ->
                permissions[i] == Manifest.permission.RECEIVE_SMS &&
                    grantResults.getOrNull(i) == PackageManager.PERMISSION_GRANTED
            }
            prefs.edit().putBoolean("sms_auto", smsGranted).apply()
            if (smsGranted) toast("短信自动入库已开启")
        }
    }

    // ================= 工具 =================

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
