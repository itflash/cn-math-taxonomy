# 账号与同步

一个家庭一个账号。孩子档案和诊断记录存在服务器上，家里每台设备登录同一个账号就能看到同样的内容。
部署方式见 [deploy/README.md](../deploy/README.md)。

## 存什么，不存什么

| 数据 | 存哪 | 同步 | 说明 |
|---|---|---|---|
| 孩子档案（昵称、年级、教材版本） | 服务器 + 本机缓存 | 是 | 只有这些，不含真实姓名 |
| 诊断记录（某次诊断的薄弱点、学习路径等） | 服务器 + 本机缓存 | 是 | 按 `subject\|seed\|目标列表` 去重 |
| 薄弱知识点 | — | — | 不是单独存的，从诊断记录现场算（`assets/children.js` 的 `latestStatus`） |
| 当前选中的孩子 | 本机 | 否 | 每台设备自己选，一台选的孩子不影响另一台 |
| 题库、知识图谱、课标 | 项目文件 | 否 | 随页面发布，本来就一样 |
| 进行中的诊断 | 本机 | 否 | 只在一台设备上有意义，做完存成记录再同步 |

## 三层存储

```
页面代码（diagnose/app.js、children/page.js、children/history.js）
     │  只用 CnmChildren 的接口，不知道同步的存在
     ▼
assets/children.js     孩子档案的读写，接口和改造前一致
     ▼
assets/sync.js         本机缓存 + 待发队列 + 调 /api/sync（window.CnmSync）
     ▼
localStorage  ──HTTP──▶  FastAPI（server/app）──▶ SQLite
```

改造前 `children.js` 直接读写 localStorage；现在同一组函数建在 `CnmSync` 上，所以诊断页 1500 多行的
`app.js` 一行没改。

## 登录门禁

没登录时访问任何页面都会跳到 `account/index.html`，登录后回到原来的地址（含参数）。
判断只看本机有没有登录凭证，不问服务器；凭证过期时接口返回 401，`sync.js` 会清掉它，下次访问重新登录。

关掉门禁（回到「不登录也能用、登录后同步」）：把 `assets/sync-config.js` 里的
`window.CNM_REQUIRE_LOGIN` 改成 `false`。`mobile/build-www.mjs` 生成的 APK 配置里默认是开的。

## 冲突怎么处理

共用一个账号意味着多台设备会同时写同一批数据。

**版本号不用设备时钟。** 服务器给每一步修改分配一个递增的 `rev`（每个账号一个序列），写到那一行上。
设备记住自己同步到哪个版本（`cursor`），下次只拉比它新的行。手机时间不准也不会判断错先后。

| 情况 | 处理 |
|---|---|
| 两台设备各自新增记录 | 不冲突，直接合并。记录 id 在设备上生成 |
| 同一份诊断重复上传 | 用记录自带的 key 去重；内容没变就不写（结果页反复刷新不会重复同步） |
| 两台设备同时改同一个孩子 | 上传时带 `baseRev`（改这项时看到的服务器版本）。服务器发现这行已经更新，拒绝本次修改，把服务器那份放进 `conflicts` 返回；本机用服务器版本覆盖，并弹提示「已在其他设备修改」 |
| 删除 | 只打删除标记（`deleted=1`），`rev` 照样加一，别的设备下次同步就知道删了，不会把它同步回来 |
| 两边都删同一个 | 不算冲突 |
| 孩子删了，另一台离线设备又传上来这个孩子的记录 | 记录照常保存（`childId` 指向已删除的孩子），设备上不显示，以后需要可以从库里恢复 |

### 离线

- 页面写数据先写本机，同时记进待发队列（`outbox`）。
- 联网、打开页面、页面重新可见时自动同步；失败按 5 秒、15 秒、1 分、5 分退避重试。
- 同一项连改几次，只发最后一次，`baseRev` 用第一次改之前看到的版本。
- 没登录时一切照旧可用，只是不离开这台设备；登录后待发队列一起推上去。

## 接口

只有四个，都在 `/api` 下，除 `login` 和 `health` 外都要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{username, password, device}` → `{token, username}` |
| POST | `/api/logout` | 只作废当前设备的 token |
| GET | `/api/me` | 当前账号 |
| POST | `/api/sync` | 一次请求里既上传修改也拉取变化（见下） |

`POST /api/sync` 请求：

```json
{
  "since": 7,
  "changes": [
    {"kind": "child",  "id": "c1",  "baseRev": 3, "data": {"name": "小满", "grade": "三年级", "textbook": "人教版"}},
    {"kind": "record", "id": "math|abc|cnm_221", "baseRev": 0, "data": {"childId": "c1", "weak": ["cnm_219"]}},
    {"kind": "child",  "id": "c2",  "baseRev": 5, "deleted": true}
  ]
}
```

响应：

```json
{
  "rev": 9,
  "reset": false,
  "changes":   [ /* rev > since 的所有行，含别的设备删掉的 */ ],
  "conflicts": [ /* 被拒绝的修改，内容为服务器当前版本 */ ]
}
```

- `kind` 只有 `child` 和 `record` 两种。
- 单条数据上限 64 KB，一次最多 500 条修改。
- `reset: true` 表示设备记的版本比服务器还新（服务器数据被重置过），设备要整份重拉。

## 表

```sql
users  (id, username, pw_hash, rev, created_at)          -- rev 是这个账号的全局版本号
tokens (token_hash, user_id, device, created_at, last_seen)
items  (user_id, kind, id, rev, deleted, data, updated_at)  -- PK (user_id, kind, id)
```

`items` 一张表存两种东西，因为它们的同步规则完全一样：有 id、有内容、只增改不原地覆盖、要能删。

## 代码位置

| 文件 | 作用 |
|---|---|
| `server/app/main.py` | 路由、请求校验、登录限制 |
| `server/app/sync.py` | 同步与冲突处理，全部逻辑集中在这一个函数 |
| `server/app/auth.py` | scrypt 密码哈希、token、登录失败计数 |
| `server/app/cli.py` | 建账号、改密码、列出设备 |
| `server/tests/test_api.py` | 14 个测试，覆盖登录、限流、合并、冲突、删除、重置 |
| `assets/sync.js` | 本机缓存、待发队列、重试 |
| `assets/children.js` | 孩子档案接口（对外和改造前一致） |
| `assets/sync-ui.js` | 状态条和冲突提示 |
| `account/` | 登录、立即同步、退出登录 |

## 试过的验证

在本机 Docker 上跑通的（`deploy` 用 `:80`，端口 18088）：

- 未登录建孩子 → 登录 → 待发队列自动推上去，状态变「已同步」
- 第二台设备（模拟）拉到了第一台推的孩子和诊断记录
- 第二台设备改了同一个孩子 → 第一台基于旧版本改 → 被拒绝，本机换成服务器版本，弹出提示
- 诊断页做完一整轮 → 记录进档案并同步到服务器；刷新结果页不会产生新的版本号
- 退出登录 → token 作废、本机数据清空、回到登录表单
- 控制台无报错

后端测试：`cd server && .venv/bin/python -m pytest -q`（14 passed）。
诊断引擎测试：`node tests/test_engine.js`（89 passed）。

## 还没做

- 注册页（故意不做：账号只能在服务器上用命令建）
- 改密码的界面（用 `python -m app.cli set-password`）
- 多账号 / 多人共享同一批孩子（现在是一个家庭一个账号）
- **记录数量上限**：改造前每个孩子最多留 40 条，超出的旧记录会被丢掉；现在不设上限（服务器和本机都不截断），
  历史不会再丢。代价是 localStorage 会一直长：一条记录约 1–3 KB（整年级筛查的记录带几十个知识点 id），
  几百条之后可能接近浏览器 5 MB 的上限，写不进去时保存会失败（页面会提示，不会静默丢数据）。
  家里几个人长期用一般到不了，真到了再做本机只留最近 N 条、服务器全留的分层。
