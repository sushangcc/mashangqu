package com.mashangqu.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * 小组件数据缓存。
 *
 * 桌面小组件运行在独立的 AppWidgetHost 进程上下文里，无法直接读到 MainActivity 的内存数据，
 * 所以每次拉取成功后把「待取数量 + 两个驿站的待取数」写入 SharedPreferences，
 * 小组件只读缓存，不自己发网络请求（避免多次刷新时重复请求、也避免 widget 里做长耗时操作）。
 */
object WidgetCache {
    private const val NAME = "mashangqu_widget"
    private const val KEY_PENDING = "pending"
    private const val KEY_CAINIAO = "cainiao"
    private const val KEY_DUODUO = "duoduo"
    private const val KEY_UPDATED = "updated_at"
    private const val KEY_ERROR = "last_error"

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** 拉取成功后写入缓存 */
    fun save(context: Context, stats: Stats, stores: List<StoreInfo>) {
        var cainiao = 0
        var duoduo = 0
        for (s in stores) {
            val name = s.store
            when {
                // 多多买菜 / 多多代收点
                name.contains("多多") -> duoduo += s.pending
                // 菜鸟驿站及普通「xx驿站」（妈妈驿站等亦归入快递驿站一栏）
                name.contains("菜鸟") || name.contains("驿站") || name.contains("菜鸟驿站") -> cainiao += s.pending
                else -> { /* 其他门店不计入这两个按钮 */ }
            }
        }
        prefs(context).edit()
            .putInt(KEY_PENDING, stats.pending)
            .putInt(KEY_CAINIAO, cainiao)
            .putInt(KEY_DUODUO, duoduo)
            .putLong(KEY_UPDATED, System.currentTimeMillis())
            .remove(KEY_ERROR)
            .apply()
    }

    /** 拉取失败时只记录错误，保留上次的数字（避免小组件突然变 0 误导用户） */
    fun saveError(context: Context, message: String) {
        prefs(context).edit().putString(KEY_ERROR, message).apply()
    }

    fun pending(context: Context): Int = prefs(context).getInt(KEY_PENDING, -1)
    fun cainiao(context: Context): Int = prefs(context).getInt(KEY_CAINIAO, 0)
    fun duoduo(context: Context): Int = prefs(context).getInt(KEY_DUODUO, 0)
    fun updatedAt(context: Context): Long = prefs(context).getLong(KEY_UPDATED, 0L)
    fun lastError(context: Context): String = prefs(context).getString(KEY_ERROR, "") ?: ""
}
