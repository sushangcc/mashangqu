package com.mashangqu.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import kotlin.concurrent.thread

/**
 * 2×2 桌面小组件：显示待取快递数 + 两个驿站快捷入口。
 *
 * 设计说明：
 * - 玻璃拟态用 XML 里的半透明白色圆角背景实现（RemoteViews 不支持实时模糊，
 *   这是 Android 桌面小组件的硬限制，只能用「半透明 + 描边 + 阴影」模拟）；
 * - 主区域点击 → 打开 App；
 * - 底部两个小按钮 → 跳转到 `store` 筛选视图（深链到 MainActivity，带 store 参数）。
 *
 * 重要：本工程在本环境无法编译（缺 gradlew / Android SDK / JDK 17），
 * 以下代码未经编译验证，需在 Android Studio 中实际构建确认。
 */
class MashangquWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
        for (id in ids) mgr.updateAppWidget(id, buildViews(context))
        // 顺带刷新一次数据
        refreshAsync(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) refreshAsync(context)
    }

    companion object {
        const val ACTION_REFRESH = "com.mashangqu.app.WIDGET_REFRESH"

        /** 供 MainActivity 在数据变化后主动刷新所有小组件实例 */
        fun updateAll(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, MashangquWidget::class.java))
            for (id in ids) mgr.updateAppWidget(id, buildViews(context))
        }

        /**
         * 在后台线程拉取数据 → 写缓存 → 回到主线程刷新界面。
         * 小组件刷新有系统时间限制（约 30 分钟一次），不能频繁请求。
         */
        fun refreshAsync(context: Context) {
            val app = context.applicationContext
            val prefs = Prefs.get(app)
            val base = prefs.getString("base_url", "") ?: ""
            val token = prefs.getString("token", "") ?: ""
            if (base.isBlank() || token.isBlank()) {
                updateAll(app)
                return
            }
            thread {
                try {
                    val r = ApiClient.fetchList(base, token, "pending")
                    WidgetCache.save(app, r.stats, r.stores)
                } catch (e: Exception) {
                    WidgetCache.saveError(app, e.message ?: "网络错误")
                }
                updateAll(app)
            }
        }

        /** 组装小组件界面 */
        private fun buildViews(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_mashangqu)

            val pending = WidgetCache.pending(context)
            val err = WidgetCache.lastError(context)

            // 主数字
            views.setTextViewText(
                R.id.widgetCount,
                when {
                    pending < 0 -> "—"
                    else -> pending.toString()
                }
            )
            views.setTextViewText(
                R.id.widgetHint,
                when {
                    pending < 0 -> "点此设置服务"
                    err.isNotBlank() -> "离线 · 点击重试"
                    pending == 0 -> "暂无待取"
                    else -> "个待取快递"
                }
            )

            // 两个驿站按钮：带各自待取数
            val cainiao = WidgetCache.cainiao(context)
            val duoduo = WidgetCache.duoduo(context)
            views.setTextViewText(R.id.widgetCainiao, "菜鸟 $cainiao")
            views.setTextViewText(R.id.widgetDuoduo, "多多 $duoduo")

            // 点击主区域 → 打开 App
            val openApp = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widgetRoot, openApp)
            views.setOnClickPendingIntent(R.id.widgetCount, openApp)

            // 菜鸟驿站按钮 → 打开 App 并筛选该门店
            views.setOnClickPendingIntent(
                R.id.widgetCainiao, storeIntent(context, "菜鸟", 101)
            )
            // 多多买菜按钮 → 打开 App 并筛选该门店
            views.setOnClickPendingIntent(
                R.id.widgetDuoduo, storeIntent(context, "多多", 102)
            )

            // 长按/右上角刷新（部分启动器支持，作为补充）
            views.setOnClickPendingIntent(
                R.id.widgetRefresh,
                PendingIntent.getBroadcast(
                    context, 103,
                    Intent(context, MashangquWidget::class.java).setAction(ACTION_REFRESH),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )

            return views
        }

        /** 深链：打开 App 并按门店关键词筛选 */
        private fun storeIntent(context: Context, keyword: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setData(Uri.parse("mashangqu://open?store=" + Uri.encode(keyword)))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra("filter_store_keyword", keyword)
            return PendingIntent.getActivity(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
    }
}
