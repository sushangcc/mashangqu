package com.mashangqu.app

import android.content.Context
import android.content.SharedPreferences

/** 配置存取（服务地址 / 口令 / 开关） */
object Prefs {
    private const val NAME = "mashangqu"

    fun get(context: Context): SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
}
