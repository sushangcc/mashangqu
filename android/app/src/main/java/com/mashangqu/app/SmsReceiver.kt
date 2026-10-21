package com.mashangqu.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Telephony

/**
 * 短信自动入库：收到快递短信 → 转发到服务端 /api/sms（服务端解析 + 查重 + 入库）
 * 这是原生 App 相对网页版的杀手级能力：无需任何短信转发 App，装好授权即全自动。
 *
 * 注意：
 * - SMS_RECEIVED 是系统豁免广播，Android 8+ 隐式广播限制不影响；
 * - 需要 RECEIVE_SMS / READ_SMS 权限（Android 6+ 运行时申请）；
 * - 入库成功发一条低优先级通知，失败静默（下一条短信自动重试）。
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return
        val body = messages.joinToString("") { it.messageBody ?: "" }.trim()
        val from = messages.firstOrNull()?.originatingAddress ?: ""
        if (body.isBlank()) return

        val prefs = Prefs.get(context)
        val auto = prefs.getBoolean("sms_auto", true)
        val base = prefs.getString("base_url", "") ?: ""
        val token = prefs.getString("token", "") ?: ""
        if (!auto || base.isBlank() || token.isBlank()) return

        val pending = goAsync()
        Thread {
            try {
                val res = ApiClient.smsAutoAdd(base, token, body, from, System.currentTimeMillis().toString())
                if (res.optBoolean("ok")) {
                    val store = res.optJSONObject("item")?.optString("store") ?: ""
                    notifyAdded(context, store)
                }
            } catch (_: Exception) {
                // 网络失败静默，下一条快递短信会自动重试
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun notifyAdded(context: Context, store: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel("mashangqu_sms", "短信入库", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification = Notification.Builder(context, "mashangqu_sms")
            .setSmallIcon(R.drawable.ic_stat_code)
            .setContentTitle("📦 快递码已自动入库")
            .setContentText("门店：${store.ifBlank { "未知" }}")
            .setAutoCancel(true)
            .build()
        try {
            nm.notify(2002, notification)
        } catch (_: Exception) {
            // 通知权限被禁则静默
        }
    }
}
