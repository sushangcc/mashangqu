# 码上取 · 桌面小组件（2×2）

显示待取快递数，底部两个按钮直达菜鸟驿站与多多买菜。玻璃拟态外观。

---

## ⚠️ 重要：本工程未经编译验证

这份 Android 工程**从未被编译过一次**。当前环境不具备构建条件：

| 要求 | 当前环境 |
|---|---|
| Gradle Wrapper（`gradlew`） | ❌ 缺失 |
| Android SDK | ❌ 未安装（无 `ANDROID_HOME`） |
| JDK 17+ | ❌ 仅有 JDK 8（`1.8.0_181`） |
| 编译产物 `app/build/` | ❌ 从未生成 |

代码经过静态检查（括号平衡、资源引用、R.id 匹配、类引用一致性均通过），**但能否编译通过、能否在手机上正常运行，需要你在 Android Studio 中实际验证。**

---

## 小组件说明

### 外观

```
┌─────────────────────────┐
│                    ⟳    │
│                         │
│           4             │  ← 待取总数（大字）
│       个待取快递         │
│                         │
│  [ 菜鸟 3 ] [ 多多 1 ]  │  ← 两个驿站入口
└─────────────────────────┘
```

- 背景：半透明白 + 24dp 圆角 + 细亮边（`widget_bg_glass.xml`）
- 按钮：更淡一档的胶囊（`widget_bg_pill.xml`）
- **注意**：RemoteViews 不支持 `backdrop-filter` 实时模糊，这是 Android 桌面小组件的系统限制。玻璃质感只能用「半透明 + 描边」模拟，做不到网页版那种真实折射。

### 交互

| 点击位置 | 行为 |
|---|---|
| 中间数字 | 打开 App |
| 「菜鸟 N」 | 打开 App 并筛选门店名含「菜鸟」的包裹 |
| 「多多 N」 | 打开 App 并筛选门店名含「多多」的包裹 |
| 右上角 ⟳ | 手动刷新数据 |

### 刷新机制

- `updatePeriodMillis = 1800000`（30 分钟）—— Android 系统对小组件刷新有频率限制，不可能做到秒级
- App 内任何操作（刷新、标记已取、新增）都会立即同步刷新小组件
- 网络失败时**保留上次数字**，只把提示文案改成「离线 · 点击重试」，避免突然变 0 误导

---

## 文件结构

```
android/app/src/main/
├── java/com/mashangqu/app/
│   ├── MashangquWidget.kt          # 小组件主体（AppWidgetProvider）
│   └── WidgetCache.kt             # 数据缓存（SharedPreferences）
└── res/
    ├── layout/widget_mashangqu.xml     # 2×2 布局
    ├── xml/widget_mashangqu_info.xml   # 小组件配置（尺寸 110dp）
    └── drawable/
        ├── widget_bg_glass.xml        # 玻璃背景
        ├── widget_bg_pill.xml         # 胶囊按钮背景
        └── ic_widget_refresh.xml      # 刷新图标
```

### 为什么需要 WidgetCache

桌面小组件运行在独立进程上下文，读不到 `MainActivity` 的内存数据。所以每次 App 拉取成功就把「待取数 + 各驿站待取数」写进 `SharedPreferences`，小组件只读缓存，**不自己发网络请求**（避免一次刷新触发多次请求，也避免在 widget 里做长耗时操作）。

---

## 构建步骤（需要你在有 Android Studio 的机器上操作）

1. 安装 [Android Studio](https://developer.android.com/studio)（自带 JDK 17+ 与 SDK）
2. **Open** → 选择本项目的 `android/` 目录
3. 等待 Gradle 同步（首次会下载 Gradle 8.9 与依赖，需联网）
   - 若提示找不到 Gradle wrapper：Android Studio 通常会提示自动修复，或在项目根执行 `gradle wrapper`
4. 小米手机开启 **开发者选项 → USB 调试**，连接电脑
5. 点 **Run ▶** 安装到手机
6. 打开 App → 设置 → 填入服务地址与口令 → 保存
7. 回到桌面 → **长按空白处 → 添加小组件 → 码上取** → 拖到桌面

---

## 已验证与未验证

**已通过（静态检查）**

```
✔ ApiClient 调用方法全部存在
✔ R 资源引用全部存在（含 layout 中的 @+id）
✔ 所有 Kotlin 文件大括号平衡
✔ widget 布局定义的 6 个 id 与代码引用完全匹配
✔ 无 CodePollingService / 超级岛 残留引用
```

**未验证**

- ❌ 能否编译通过
- ❌ 小组件在真机桌面上能否正常显示
- ❌ 玻璃背景在深色壁纸下的实际观感
- ❌ 门店关键词筛选（菜鸟/多多）在真机上的跳转行为

---

## 关于小米超级岛

小米官方超级岛的接入门槛（2025 年 10 月发布的官方指南）：

1. 注册小米开发者账号
2. 应用**上架小米应用商店**
3. 开发者后台申请开通超级岛
4. 提交**上岛场景预审材料**
5. 审核通过后开发联调
6. 申请**设备白名单**
7. 提交正式环境 APK 审核
8. **灰度发布，7-15 天后全量**

个人自用工具无法通过第 2、4 步，因此本项目**不提供超级岛功能**，改用桌面小组件满足「一眼看到待取数」的需求。相关代码（`CodePollingService.kt`）已删除。
