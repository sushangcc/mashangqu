# 🆓 零成本公网方案（不用买服务器）

家里电脑保持开机在线，即可让手机**在任何网络**（4G/5G/公司WiFi）访问取件码服务，全程免费。

**首选：Tailscale 免费组网** —— 手机与电脑组成一个加密的私有网络，手机上直接访问"家里的电脑"，稳定、安全、地址固定。

---

## 方案一：Tailscale（推荐）

原理：Tailscale 基于 WireGuard，把你所有的设备（电脑、多台手机）组成一个私有虚拟局域网。
手机装 Tailscale 后，出门在外也像在家里一样，直接访问 `http://100.x.x.x:8000`。
全程加密，只有你自己账号下的设备能访问，比公网暴露更安全。

### 1. 电脑端（Windows，跑服务的那台）

1. 下载安装：https://tailscale.com/download （Windows 版，安装后右下角出现图标）；
2. 打开 Tailscale，用账号登录（微软/GitHub/谷歌/邮箱任选）；
3. 登录后查看本机分配的内网地址：右键托盘图标 → Admin console，或 PowerShell 执行：
   ```powershell
   tailscale ip -4
   ```
   记下 `100.x.y.z` 这个地址（固定不变）。

### 2. 手机端（小米等所有要用的手机）

1. 应用商店搜索 **Tailscale**（或官网 https://tailscale.com/download/android 下载 APK）；
2. 安装后**登录同一个账号**（必须和电脑同一个账号）；
3. 登录后手机就和电脑在同一私有网络了。

### 3. 验证

手机浏览器打开 `http://100.x.y.z:8000`，输入访问口令（`data\token.txt` 里那 6 位）→ 应能看到取件码页面。
Android App 的服务地址同样填 `http://100.x.y.z:8000`。

### 4. 让服务"永不掉线"（重要）

服务端要在电脑开机时自动启动（已提供脚本）：

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\install-autostart.ps1"
```

电脑关机时服务自然不可用（这是家里电脑方案的唯一限制）。

### 常见问题

| 问题 | 解决 |
| --- | --- |
| 手机打不开 100.x.y.z | 确认手机 Tailscale 已登录且在线（下拉通知栏有 Tailscale 常驻通知）；电脑 Tailscale 是否开着 |
| 电脑重启后地址变了 | Tailscale 地址是固定的，不会变；变了就在电脑上 `tailscale ip -4` 重新查 |
| 想用域名代替 IP | Tailscale 管理后台开启 MagicDNS 后，可用 `http://电脑主机名:8000` |
| 手机 App 提示明文 HTTP | 已内置放行，http://100.x.y.z 可用；介意可后续配 HTTPS |

---

## 方案二：Cloudflare Tunnel（备选）

不想装 Tailscale 手机端时用：电脑跑一个免费隧道程序，把服务映射成公网 HTTPS 域名。

1. 电脑装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)；
2. 启动快速隧道（免费临时域名，每次重启变化）：
   ```powershell
   cloudflared tunnel --url http://localhost:8000
   ```
   输出里的 `https://xxxx.trycloudflare.com` 就是公网地址；
3. 手机 App / 网页填这个地址即可。

> 限制：免费临时域名每次重启隧道会变（App 需重新改地址）；想要固定域名需要自己的域名（约几元~几十元/年）。
> 若希望固定地址且不想付费，还是方案一（Tailscale）更省心。

---

## 对比小结

| | Tailscale（推荐） | Cloudflare Tunnel | 云服务器 |
| --- | --- | --- | --- |
| 费用 | **免费** | 免费（临时域名） | 38 元/年起 |
| 手机端 | 需装 Tailscale App | 无需 | 无需 |
| 地址 | 固定 | 每次变化 | 固定 |
| 依赖 | 家里电脑在线 | 家里电脑在线 | 无 |
| 安全性 | 私有加密网络 | 公网 HTTPS | 公网 |

**结论**：电脑常开 → Tailscale 免费方案完全满足"多手机互通、不限局域网、不花钱"。
