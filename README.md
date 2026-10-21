# 📦 码上取

> 多平台网购取件码统一管理工具 —— 自托管、零依赖、支持 Android 桌面小组件

淘宝/京东/拼多多/抖音等平台的快递取件码散落在各个 App 和短信里，查起来很麻烦。这个工具把**所有取件码集中到一个地方**，还能自动从短信里识别提取。

## 功能亮点

| 功能 | 说明 |
|---|---|
| **统一查看** | 按驿站分类、待取/已取状态、一键复制取件码 |
| **短信智能解析** | 内置 20+ 种快递短信格式，粘贴即识别（菜鸟/妈妈驿站/兔喜/多多买菜/美团优选/京东/顺丰/丰巢…） |
| **AI 教学** | 遇到识别不了的格式，手动标注一次，系统记住这类短信的规律，以后自动识别 |
| **包裹备注** | 每条包裹可加文字备注和图片（前端压缩后存储） |
| **到期提醒** | 默认 3 天有效期，今日到期/已过期自动标红 |
| **多端同步** | 家人的手机打开同一网址，数据实时互通（20 秒轮询） |
| **离线可用** | 断网时查看本地缓存，新建的记录排队等联网后自动上传 |
| **深色模式** | 跟随系统 / 手动切换三档 |
| **桌面小组件** | Android 2×2 组件，显示待取数，可直达菜鸟/多多驿站 |
| **PWA** | 可"添加到主屏幕"，像原生 App 一样用 |

## 技术特点

**刻意保持零依赖**：服务端只用 Node.js 内置模块，前端是原生 HTML/CSS/JS —— 没有框架、没有构建步骤、没有 CDN 资源。`git clone` 下来直接 `node server.js` 就能跑。

```
后端    Node.js 内置模块        573 行
解析器  纯函数，无外部依赖       333 行
存储    JSON 文件 + 原子写入     304 行
前端    原生 HTML/CSS/JS       2788 行
Android Kotlin + WebView       700 行
测试    自建断言框架，252 项断言
```

**界面**采用液态玻璃（Liquid Glass）设计：半透明玻璃材质、底栏水滴指示块、弹簧动效、完整深色主题。

## 快速开始

```bash
# 需要 Node.js 18+
node server.js
```

Windows 也可以双击 `start.bat`。

启动后终端会显示访问地址与口令：

```
=============================================
  码上取 已启动
  本机访问:   http://localhost:8000
  局域网访问: http://192.168.1.100:8000
  访问口令:   xxxxxx
=============================================
```

浏览器打开对应地址，输入**访问口令**即可使用。

> 首次启动会自动生成 6 位口令并保存在 `data/token.txt`。
>
> 💡 **开机自启**（Windows）：`powershell -ExecutionPolicy Bypass -File ".\tools\install-autostart.ps1"`，登录后自动隐藏窗口启动服务；卸载加 `-Uninstall`。

### 多手机互通（核心需求）

1. 确认手机和电脑在**同一个 WiFi**；
2. 手机浏览器打开 `http://<电脑IP>:8000`（电脑 IP 用 `ipconfig` 查看，如 `192.168.1.100`）；
3. 输入**同一个访问口令**；
4. 任意一台手机添加/标记，其他手机 20 秒内自动同步，下拉也可手动刷新。

> ⚠️ Windows 防火墙首次会弹窗询问，选择"允许访问"；若没弹，手动放行端口 8000：
> ```powershell
> netsh advfirewall firewall add rule name="码上取" dir=in action=allow protocol=TCP localport=8000
> ```

---

## 短信自动提取（强烈推荐）

快递取件码短信到达手机后自动入库，无需手动粘贴。以开源 App **SMS Forwarder**（短信转发器）为例：

1. 手机安装 SMS Forwarder（应用商店 / GitHub 搜索）；
2. 新建转发规则：
   - **接收人/条件**：发件人包含 `1069` 或内容包含 `取件码`（按你的实际情况）；
   - **转发方式**：Webhook / HTTP POST；
   - **URL**：`http://<电脑IP>:8000/api/sms?token=<访问口令>`；
   - **请求体（JSON）**：
     ```json
     {"text":"%SMS_TEXT%","from":"%SMS_FROM%","time":"%SMS_RECEIVED_DATE%"}
     ```
     （变量名以你所用 App 的模板为准，`text` 为必填短信原文）
3. 保存后测试：给手机发一条快递短信，刷新网页即可看到自动入库。

> 非快递短信会被自动忽略；重复短信自动去重（同单号或同取件码+同门店 7 天内不重复入库）。
>
> 💡 网页端 **设置 → 短信自动提取 → 「发送测试短信」**：一键验证转发链路是否打通（dryRun 模式，只解析不入库，不污染数据）。
>
> 也可以手动测试 Webhook：
> ```powershell
> Invoke-RestMethod -Method Post -Uri "http://localhost:8000/api/sms?token=口令" -ContentType "application/json" -Body '{"text":"【菜鸟驿站】您的包裹已到阳光花园驿站，取件码：1234"}'
> ```

---

## 部署到公网（在外也能用）

**零成本首选（不买服务器）**：家里电脑保持开机 + **Tailscale 免费组网**——电脑和手机装同一个免费 App（同一账号），手机在任何网络直接访问 `http://100.x.y.z:8000`，加密、地址固定、免费。完整步骤见 [deploy/FREE.md](deploy/FREE.md)。

进阶方案（需要固定域名或不想依赖家里电脑）：

**方案 A：云服务器**（轻量 38 元/年起，systemd 常驻 + 可选 HTTPS）→ [deploy/CLOUD.md](deploy/CLOUD.md)
**方案 B：Cloudflare Tunnel 免费隧道**（无需手机端，免费临时域名，重启会变）→ [deploy/FREE.md](deploy/FREE.md)

> 🔒 安全说明：界面（静态页面）无需口令即可访问，但**所有数据接口均需口令**；已做路径穿越防护。公网使用时建议配 HTTPS + 强口令。

---

## 配置

编辑项目根目录的 `config.json`（没有则用环境变量）：

```json
{
  "port": 8000,
  "host": "0.0.0.0",
  "token": "改成你的强口令",
  "expiryDays": 3,
  "dataDir": "./data"
}
```

| 配置项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `port` | `PORT` | `8000` | 监听端口 |
| `host` | `HOST` | `0.0.0.0` | 监听地址 |
| `token` | `TOKEN` | 自动生成 | 访问口令（多手机共用） |
| `expiryDays` | `EXPIRY_DAYS` | `3` | 取件码默认有效天数 |
| `dataDir` | `DATA_DIR` | `./data` | 数据目录 |

> 修改口令：编辑 `config.json` 或删除 `data/token.txt` 后重启服务。

---

## 数据备份

- **网页端**：设置 → 导出备份 / 导入恢复；
- **直接备份**：复制 `data/db.json` 文件即可；
- 导入会先自动备份当前数据到 `data/backup-<时间戳>.json`。

---

## 使用小技巧

- **批量录入**：添加 → 批量粘贴，把多平台 App 复制出来的短信一次性粘贴，自动解析；
- **按单号查取件码**：顶部搜索框直接输入快递单号；
- **按门店分类**：点顶部门店标签只看某一驿站/柜的包裹；
- **到期处理**：顶部横幅提示"今日到期/已过期"数量，点击直达待取列表；"即将到期"排序让最紧急的排最前；
- **添加到主屏幕**：手机浏览器菜单 → "添加到主屏幕"，全屏像 App 一样使用（PWA）；
- **已取清理**：已取列表里长按删除，保持列表干净（详情页有删除按钮）。

---

## 目录结构

```
码上取/
├── server.js              # 服务端（零依赖，HTTP + API + Webhook + 静态托管）
├── start.bat / start.sh   # 一键启动脚本
├── config.json            # 配置（可选，参照 config.example.json）
├── deploy/
│   └── mashangqu.service   # Linux systemd 常驻服务样例（云服务器）
├── lib/
│   ├── parser.js          # 中文快递短信解析器（取件码/单号/门店/快递公司）
│   └── store.js           # JSON 数据存储（原子写入 + 查重 + 导入导出）
├── public/                # 前端（PWA）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── manifest.webmanifest
│   ├── sw.js              # Service Worker（离线外壳）
│   └── icons/
├── android/               # 原生 Android App + 桌面小组件（Android Studio 打开，详见 android/README.md）
│   ├── settings.gradle.kts
│   ├── README.md          # 构建/安装/小米设置/排查清单
│   └── app/src/main/java/com/mashangqu/app/
│       ├── MainActivity.kt        # 主界面（服务地址/口令/列表/开关）
│       ├── MashangquWidget.kt      # 2×2 桌面小组件（待取数 + 菜鸟/多多快捷入口）
│       ├── WidgetCache.kt         # 小组件数据缓存
│       ├── ApiClient.kt           # API 客户端（HttpURLConnection）
│       └── models.kt
├── data/                  # 运行数据（db.json / token.txt，自动生成）
├── test/                  # 自动化测试
│   ├── samples.mjs        # 快递短信测试样例
│   ├── run-tests.mjs      # 解析器单元测试
│   └── api.test.mjs       # API 集成测试
└── tools/gen-icon.mjs     # PWA 图标生成脚本
```

---

## 运行测试

**一键全量测试**（自动拉起空数据测试服务，跑完自动清理）：

```bash
npm run test:all     # = 解析器 + API + App 接口契约 + 前端 E2E（需先装 jsdom，见下）
```

分步执行：

```bash
node test/run-tests.mjs            # 解析器单元测试 + 前端静态检查（无需启动服务）
node test/api.test.mjs             # API 集成测试（需先启动空数据测试服务）
node test/api-contract.test.mjs    # App 接口契约测试（复刻 Android ApiClient.kt 的请求）
node test/frontend.test.mjs        # 前端端到端测试（jsdom 真实执行 app.js）
```

> 前端 E2E 依赖 jsdom：`npm install --no-save --cache .npm-cache jsdom`（已加入 .gitignore）。
> 手动分步跑 API/前端测试时，需要先启动一个**空数据**的测试服务：
> `$env:PORT=8123; $env:TOKEN='test-token-123'; $env:DATA_DIR='./data-test'; node server.js`

Android 工程静态一致性检查（无需 SDK，核对 API 调用 / 资源引用 / 类引用）：

```bash
node tools/check-android.mjs
```

---

## Android App

`android/` 目录提供原生 App，主界面用 **WebView 加载打包进 APK 的网页版**，因此外观与浏览器完全一致（液态玻璃、底栏、深色主题全部保留），同时具备网页做不到的能力：

- **完全离线**：网页资源打包在 APK 内，断网也能打开界面
- **短信自动入库**：授予短信权限后，取件码短信到达即自动入库，无需第三方转发 App
- **2×2 桌面小组件**：显示待取快递总数，底部两个按钮直达「菜鸟驿站」与「多多买菜」，玻璃拟态外观

> 为何不用纯原生界面：手写 View 难以还原网页版的精致度，且维护两套 UI 成本高。WebView 方案让网页版改动自动体现在 App 上（只需同步资源后重新编译）。

构建步骤见 [android/README.md](android/README.md)，小组件说明见 [android/WIDGET.md](android/WIDGET.md)。

```bash
# 同步网页资源到 APK
node tools/sync-www.mjs
# 编译
cd android && gradle assembleDebug
```

> 关于小米超级岛：官方接入需要企业开发者账号 + 应用上架 + 场景预审 + 设备白名单 + 灰度发布，个人项目无法通过审核，因此**本项目不提供超级岛功能**，改用桌面小组件满足「一眼看到待取数」的需求。

---

## 常见问题

**Q: 手机打不开 `http://电脑IP:8000`？**
A: 确认同一 WiFi；防火墙放行 8000 端口（见上文）；确认电脑 IP 正确（`ipconfig`）。

**Q: 取件码一般几天有效？**
A: 各平台通常 3 天，可在设置里改默认值（1~30 天），每条记录也可单独设置。

**Q: 数据存在哪？**
A: 全部存在运行服务的电脑/服务器上（`data/db.json`），换手机不丢数据，重新登录即可看到全部记录。**`data/` 已在 `.gitignore` 中，不会上传到代码仓库。**

**Q: 支持哪些快递短信格式？**
A: 菜鸟驿站、妈妈驿站、快递超市、兔喜生活、多多买菜、美团优选、淘菜菜、天猫超市、京东、顺丰、丰巢、极兔、中通、圆通、申通、韵达、德邦、拼多多等常见格式均已覆盖，支持货架码（3-2-4523）、纯数字/字母数字单号、小写单号前缀等变体，测试样例见 `test/samples.mjs`。

**Q: 能在外网访问吗？**
A: 可以，两种方式：部署到云服务器（[deploy/CLOUD.md](deploy/CLOUD.md)），或用 Tailscale 免费组网（[deploy/FREE.md](deploy/FREE.md)）。家庭宽带的公网 IP 若被运营商 NAT（CGNAT），端口转发无效。

---

## 隐私说明

- 所有数据存放在**你自己的机器**上（`data/db.json`），不上传任何第三方服务器
- 访问需要口令，服务端做了路径穿越防护
- 仓库中**不包含**任何真实取件码、驿站名称或访问口令

## 许可

个人自用项目，代码可自由参考。提 issue 或 PR 都欢迎。

---

## 致谢

界面设计参考 Apple Liquid Glass 风格；快递短信格式的整理来自日常使用中遇到的真实短信。
