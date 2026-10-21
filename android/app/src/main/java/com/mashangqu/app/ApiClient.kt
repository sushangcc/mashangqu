package com.mashangqu.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class ApiException(message: String) : Exception(message)

/**
 * 完整 API 客户端：仅用 HttpURLConnection + 系统自带 org.json，无第三方网络库
 */
object ApiClient {

    private const val TIMEOUT = 10000

    private fun request(
        method: String,
        baseUrl: String,
        token: String,
        path: String,
        body: JSONObject? = null
    ): JSONObject {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = TIMEOUT
            conn.readTimeout = TIMEOUT
            conn.setRequestProperty("X-Auth-Token", token)
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.readText() ?: ""
            val json = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (code == 401) throw ApiException("口令不正确")
            if (code !in 200..299) throw ApiException(json.optString("message", "服务返回 $code"))
            return json
        } finally {
            conn.disconnect()
        }
    }

    private fun q(name: String, value: String): String =
        URLEncoder.encode(value, "UTF-8").let { "$name=$it" }

    /** 拉取列表 + 门店 + 统计（一次拿全） */
    fun fetchList(
        baseUrl: String, token: String,
        status: String = "pending", q: String = "", store: String = "", sort: String = "arrivedAt"
    ): PackageListResult {
        val params = mutableListOf<String>()
        if (status.isNotBlank() && status != "all") params.add(q("status", status))
        if (q.isNotBlank()) params.add(q("q", q))
        if (store.isNotBlank()) params.add(q("store", store))
        params.add(q("sort", sort))
        val json = request("GET", baseUrl, token, "/api/packages?" + params.joinToString("&"))
        val arr = json.getJSONArray("items")
        val items = (0 until arr.length()).map { PackageItem.fromJson(arr.getJSONObject(it)) }
        val storesArr = json.getJSONArray("stores")
        val stores = (0 until storesArr.length()).map { StoreInfo.fromJson(storesArr.getJSONObject(it)) }
        return PackageListResult(items, stores, Stats.fromJson(json.getJSONObject("stats")))
    }

    /** 手动新增 */
    fun addPackage(
        baseUrl: String, token: String,
        store: String, code: String, carrier: String, tracking: String,
        platform: String, expiresDays: Int?
    ): JSONObject {
        val body = JSONObject()
            .put("store", store)
            .put("code", code)
            .put("carrier", carrier)
            .put("tracking", tracking)
            .put("platform", platform)
        if (expiresDays != null) body.put("expiresDays", expiresDays)
        return request("POST", baseUrl, token, "/api/packages", body)
    }

    /** 更新状态（picked / pending） */
    fun patchStatus(baseUrl: String, token: String, id: String, status: String): JSONObject =
        request("PATCH", baseUrl, token, "/api/packages/$id", JSONObject().put("status", status))

    /** 删除 */
    fun deletePackage(baseUrl: String, token: String, id: String): JSONObject =
        request("DELETE", baseUrl, token, "/api/packages/$id")

    /** 短信自动入库（服务端负责解析与查重） */
    fun smsAutoAdd(baseUrl: String, token: String, text: String, from: String, time: String): JSONObject {
        val body = JSONObject()
            .put("text", text)
            .put("from", from)
            .put("time", time)
        return request("POST", baseUrl, token, "/api/sms", body)
    }

    /** 测试连接：拉取统计即可 */
    fun testConnection(baseUrl: String, token: String): Stats {
        val json = request("GET", baseUrl, token, "/api/packages?status=pending")
        return Stats.fromJson(json.getJSONObject("stats"))
    }
}
