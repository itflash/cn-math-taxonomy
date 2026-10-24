# 部署：Docker + 同步后端

网页和题库是静态文件，由 Caddy 提供；孩子档案和诊断记录存在服务器上，`/api` 走 FastAPI。
一个家庭一个账号，多台设备（手机、平板、以后的 APK）登录同一个账号，数据自动同步。

```
浏览器 / APK
     │  HTTPS
     ▼
  web（Caddy：静态页面 + 反代 /api）
     │  内网
     ▼
  api（FastAPI + SQLite）── /data/cnm.sqlite3（卷）
     │
  backup（每天备份一份到 BACKUP_DIR）
```

## 第一次部署

```bash
cd deploy
cp .env.example .env
vi .env                 # 填 SITE_ADDRESS（域名）等
docker compose up -d --build
docker compose exec api python -m app.cli create-user 家长   # 交互输入密码，至少 8 位
```

`create-user` 需要能读终端，在服务器上直接执行；用 `docker compose run --rm api python -m app.cli create-user 家长` 也可以。
不开放注册，账号只能这样建。

打开 `https://你的域名/` 就能用。登录入口在「档案」页右上角，或直接访问 `/account/`。

### 本机试跑

```bash
cd deploy
printf 'SITE_ADDRESS=:80\nHTTP_PORT=18088\nHTTPS_PORT=18443\nPIP_INDEX_URL=\n' > .env
docker compose up -d --build
docker compose exec api python -m app.cli create-user family
# 打开 http://localhost:18088/
```

`:80` 表示不申请证书、直接跑 HTTP，只适合本机。线上必须是域名，否则 PWA 和密码传输都没保护。

## 配置项（deploy/.env）

| 变量 | 说明 |
|---|---|
| `SITE_ADDRESS` | 域名，如 `xuexi.example.com`。Caddy 自动申请并续期 HTTPS 证书。本机测试写 `:80` |
| `HTTP_PORT` / `HTTPS_PORT` | 宿主机映射端口，默认 80 / 443 |
| `CORS_ORIGINS` | 允许跨源访问 `/api` 的来源，默认 `https://localhost,capacitor://localhost`（APK 用）。网页版同源，不需要加 |
| `BACKUP_DIR` | 备份文件放在宿主机哪个目录，默认 `./backups`，保留最近 14 份 |
| `PIP_INDEX_URL` | 国内服务器装 Python 依赖慢时填镜像源，如 `https://pypi.tuna.tsinghua.edu.cn/simple` |

## 常用命令

```bash
docker compose logs -f api                 # 看接口日志
docker compose exec api python -m app.cli list-users
docker compose exec api python -m app.cli set-password 家长   # 同时会让所有设备重新登录
docker compose exec api python -m app.cli logout-all 家长     # 丢失设备时用
docker compose up -d --build               # 改了代码后更新
docker compose down                        # 停（数据在卷里，不会丢）
```

## 备份与恢复

`backup` 容器每天用 `sqlite3 .backup` 存一份到 `BACKUP_DIR/cnm-日期.sqlite3`，保留 14 份。
恢复：停掉 api，把备份文件拷回卷里的 `/data/cnm.sqlite3`，再启动。

```bash
docker compose stop api
docker run --rm -v cnm_api-data:/data -v "$PWD/backups":/backups alpine \
  sh -c 'cp /backups/cnm-2026-10-24.sqlite3 /data/cnm.sqlite3'
docker compose start api
```

## 安全说明

- 密码用 scrypt 加盐哈希，库里不存明文。
- 登录发随机 token，库里只存 sha256；token 放 `Authorization: Bearer`，不用 cookie（APK 跨源时 cookie 很难处理）。
- token 按最后使用时间滑动过期，默认 180 天（`CNM_TOKEN_TTL_DAYS`）。
- 同一用户名或同一 IP 在 15 分钟内失败 5 次后暂时拒绝登录（`CNM_LOGIN_MAX_FAILS`、`CNM_LOGIN_WINDOW_SECONDS`）。
- 只有 `/api` 暴露给外网；`data/`、`server/`、`scripts/`、`docs/` 都进不了镜像。
- 这是孩子的学习数据：档案只存昵称和年级，不存真实姓名，也不收集手机号或邮箱。

## 数据模型与同步规则

见 [docs/sync.md](../docs/sync.md)。
