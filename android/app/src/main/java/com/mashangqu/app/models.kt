package com.mashangqu.app

import org.json.JSONObject

/** 包裹/取件码数据模型（与服务端 /api/packages 返回字段对应） */
data class PackageItem(
    val id: String,
    val store: String,
    val code: String,
    val carrier: String,
    val tracking: String,
    val platform: String,
    val note: String,
    val photo: String,
    val status: String,
    val arrivedAt: String,
    val expiresAt: String
) {
    companion object {
        fun fromJson(o: JSONObject): PackageItem = PackageItem(
            id = o.optString("id"),
            store = o.optString("store"),
            code = o.optString("code"),
            carrier = o.optString("carrier"),
            tracking = o.optString("tracking"),
            platform = o.optString("platform"),
            note = o.optString("note"),
            photo = o.optString("photo"),
            status = o.optString("status"),
            arrivedAt = o.optString("arrivedAt"),
            expiresAt = o.optString("expiresAt")
        )
    }
}

/** 统计信息 */
data class Stats(
    val pending: Int,
    val picked: Int,
    val expiring: Int,
    val expired: Int
) {
    companion object {
        fun fromJson(o: JSONObject) = Stats(
            pending = o.optInt("pending"),
            picked = o.optInt("picked"),
            expiring = o.optInt("expiring"),
            expired = o.optInt("expired")
        )
    }
}

/** 门店聚合信息 */
data class StoreInfo(val store: String, val pending: Int) {
    companion object {
        fun fromJson(o: JSONObject) = StoreInfo(
            store = o.optString("store"),
            pending = o.optInt("pending")
        )
    }
}

/** 列表页一次拉取的全部数据 */
data class PackageListResult(
    val items: List<PackageItem>,
    val stores: List<StoreInfo>,
    val stats: Stats
)
