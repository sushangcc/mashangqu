# ☁️ 云服务器部署指南（让手机在外网也能用）

把服务端部署到公网后，手机 App / 网页在任何网络下都能访问，多手机实时互通。

---

## 一、服务器选型推荐（2026 年参考价）

| 平台 | 推荐配置 | 参考价 | 适合 |
| --- | --- | --- | --- |
| [阿里云轻量应用服务器](https://developer.aliyun.com/article/1745364#1) | 2核2G 或 2核4G，40GB SSD | 约 **38~100 元/年**（新客活动） | 推荐首选，国内访问快 |
| [腾讯云轻量服务器](https://cloud.tencent.com.cn/act/pro/warmup-202606) | 2核2G~4核4G | 新客约 **38 元/年起** | 与阿里云同档 |
| 阿里云 ECS 突发型 | 2核2G | 约 **99 元/年** | 备选 |

**建议**：2核2G 完全够用（本项目极轻量）；选**国内地域**（访问快）、**Ubuntu 22.04/24.04** 系统镜像、按年付费最划算。新用户活动价通常在官网活动页，别原价买。

> 买完你会得到：服务器公网 IP、root 密码（或密钥）。

---

## 二、部署步骤（约 10 分钟）

### 1. SSH 登录服务器

Windows 自带终端即可：

```powershell
ssh root@你的服务器IP
```

### 2. 安装 Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v   # 确认 >= 18
```

### 3. 上传项目

在**你的电脑**上（PowerShell，进入项目目录）：

```powershell
scp -r .\server.js .\lib .\public .\data .\config.example.json root@你的服务器IP:/opt/
ssh root@你的服务器IP "mv /opt/config.example.json /opt/config.json && mkdir -p /opt/data"
```

> 小文件项目，scp 秒传。之后每次改动只需重传 `server.js` 和 `lib/`。

### 4. 配置口令并启动

```bash
cd /opt
# 编辑 config.json 设置强口令（不要用默认示例）
nano config.json        # token 改成你的口令
node server.js          # 先手动跑一次，确认正常后 Ctrl+C
```

### 5. 注册 systemd 常驻（崩溃自动重启 + 开机自启）

```bash
cp /opt/deploy/mashangqu.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mashangqu
systemctl status mashangqu        # 查看状态
journalctl -u mashangqu -f        # 实时日志
```

> ⚠️ 若项目路径不是 `/opt`，先编辑 `/etc/systemd/system/mashangqu.service` 里的 `WorkingDirectory` 和 `ExecStart`。

### 6. 云厂商安全组放行端口

在云控制台「安全组 / 防火墙」中放行 **TCP 8000**（来源 0.0.0.0/0）。

### 7. 验证

浏览器打开 `http://服务器IP:8000`，输入口令即可使用；手机 App 填同样的地址。

---

## 三、可选：配置 HTTPS（推荐，更安全）

Android 9+ 默认禁止明文 HTTP，虽然本 App 已内置放行，但**公网强烈建议 HTTPS**（数据加密、防运营商劫持）。

用 nginx 反代 + 免费证书（certbot）：

```bash
apt-get install -y nginx certbot python3-certbot-nginx

# nginx 配置 /etc/nginx/sites-available/mashangqu
cat > /etc/nginx/sites-available/mashangqu <<'EOF'
server {
    listen 80;
    server_name kuaidi.example.com;   # 换成你的域名（需先解析到服务器IP）

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}
EOF
ln -s /etc/nginx/sites-available/mashangqu /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 申请免费证书并自动续期
certbot --nginx -d kuaidi.example.com
```

之后手机 App 填 `https://kuaidi.example.com` 即可。

> 无域名也可用 IP + 自签证书，但手机会提示不信任，不推荐；建议花几块钱买个域名。

---

## 四、多手机互通

- 每台手机安装 App → 填同一个 `https://域名` 或 `http://IP:8000` + **同一个口令**；
- 任意手机添加/标记，其他手机自动同步（App 每次打开刷新，后台提醒服务每 30 秒轮询）；
- 网页版（PWA）同样可用，作为备用入口。

---

## 五、日常维护

```bash
systemctl restart mashangqu            # 重启服务
journalctl -u mashangqu -f             # 看日志
scp root@服务器IP:/opt/data/db.json .  # 备份数据
```
