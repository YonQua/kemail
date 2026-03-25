# kemail

一个基于 Cloudflare Workers + D1 + KV 的临时邮箱 API 项目，包含：

- 入站邮件接收与存储
- 邮件查询、详情、原始 MIME 和富解析
- 管理后台与数据看板
- 域名池同步、启停和发号
- 公开 OpenAPI / API 文档页

仓库采用 [MIT](./LICENSE) 许可证。

## 公开仓库边界

GitHub 仓库默认只保留这些适合公开分享的内容：

- `worker.js` 与 `worker/`
- `manage-src/`
- `scripts/`
- `specs/openapi.json`
- `package.json` / `package-lock.json`
- `README.md` / `LICENSE`
- [`wrangler.demo.toml`](./wrangler.demo.toml)

这些内容只保留在本地，不进入 GitHub：

- `wrangler.toml`
- `CHANGELOG.md`
- `public/`
- `docs/`
- `test_mail_api.py`
- `task_plan.md` / `findings.md` / `progress.md`
- `.wrangler/`、`.env*`、IDE 配置、日志和其他本地开发残留

换句话说，这个仓库的定位是：

- GitHub：源码、构建脚本、契约源、模板配置、部署说明
- 本地工作区：live 配置、生成产物、私人文档、调试脚本、过程记录

## 仓库结构

- `worker.js`：Cloudflare Worker 入口
- `worker/`：后端运行时模块
- `manage-src/`：管理页和文档页源码
- `scripts/build-manage-assets.mjs`：构建本地 `public/` 静态产物
- `scripts/run-worker-regression.mjs`：本地 Worker 集成回归
- [`specs/openapi.json`](./specs/openapi.json)：完整接口契约源
- [`wrangler.demo.toml`](./wrangler.demo.toml)：公开模板配置

## 快速开始

### 1. 安装依赖

```bash
npm ci
```

### 2. 准备本地 Wrangler 配置

```bash
cp wrangler.demo.toml wrangler.toml
```

然后只在你本地的 `wrangler.toml` 中替换这些值：

- Worker 名称
- D1 数据库 ID
- KV namespace ID
- 自定义域名或 route 配置

推荐绑定名称：

- D1 binding：`DB`
- KV binding：`CACHE`
- Assets binding：`ASSETS`

### 3. 初始化 D1

全新安装可直接执行下面这组建表 SQL：

```sql
CREATE TABLE emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  body_readable TEXT,
  received_at DATETIME,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_recipient ON emails (recipient);
CREATE INDEX idx_recipient_received_at ON emails (recipient, received_at DESC);
CREATE INDEX idx_received_at ON emails (received_at);
CREATE INDEX idx_is_read ON emails (is_read);
CREATE INDEX idx_is_starred ON emails (is_starred);

CREATE TABLE managed_domains (
  zone_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  zone_status TEXT,
  issuable_enabled INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  sync_error TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mail_daily_metrics (
  day TEXT PRIMARY KEY,
  received_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE mail_sender_daily_metrics (
  day TEXT NOT NULL,
  sender TEXT NOT NULL,
  received_total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, sender)
);
```

如果是旧库升级，至少补跑一次：

```sql
CREATE INDEX IF NOT EXISTS idx_recipient_received_at
ON emails (recipient, received_at DESC);
```

### 4. 配置 secrets

```bash
npx wrangler secret put READ_API_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

说明：

- `READ_API_KEY`：对外查询与常规读写流程
- `ADMIN_API_KEY`：后台管理能力
- `CLOUDFLARE_API_TOKEN`：域名池同步用的 Cloudflare Token

如果暂时不用域名池同步，可以先不配置 `CLOUDFLARE_API_TOKEN`。

### 5. 本地验证与部署

```bash
npm run build:manage
npm run test:worker
npm run verify:predeploy
npm run deploy
```

脚本说明：

- `npm run dev`：本地开发
- `npm run build:manage`：生成本地 `public/` 静态产物
- `npm run test:worker`：运行 Worker 集成回归
- `npm run verify:predeploy`：构建 + 回归 + `wrangler deploy --dry-run`
- `npm run deploy`：构建 + 回归 + 正式部署

## Cloudflare 部署主线

建议按这个顺序操作：

1. 复制 [`wrangler.demo.toml`](./wrangler.demo.toml) 到本地 `wrangler.toml`
2. 填入你自己的 Worker 名称、D1 / KV 资源 ID
3. 执行上面的 D1 建表 SQL
4. 配置 `READ_API_KEY`、`ADMIN_API_KEY`、`CLOUDFLARE_API_TOKEN`
5. 运行 `npm run verify:predeploy`
6. 运行 `npm run deploy`
7. 在 Cloudflare Email Routing 中把 catch-all 或目标地址转发到这个 Worker
8. 如需正式对外使用，再绑定自定义域名，并在本地 `wrangler.toml` 里关闭 `workers_dev`

## 文档与接口入口

- 公开 API 文档：`/api-docs`
- 公开 OpenAPI：`/openapi.json`
- 公开运行时版本：`/api/version`
- 管理员内部文档：`/api/admin/docs`
- 管理员内部 OpenAPI：`/api/admin/openapi`

更完整的请求/响应结构，以 [`specs/openapi.json`](./specs/openapi.json) 和运行中的文档页为准。

## 关键行为

- `POST /api/addresses/generate` 是推荐发号入口
- `GET /api/version` 可公开查看当前线上实例暴露的版本号
- `READ_API_KEY` 可用于发号、查列表、查详情、查最新邮件、删邮件
- 星标、标记已读、富解析、原始 MIME 与域名池管理默认需要 `ADMIN_API_KEY`
- 管理页支持只读密钥登录；只读会话不会暴露管理员入口
- Workers KV 只承担未鉴权 API 的防刷限流
- `/api/latest` 当前直接走 D1 查询，性能依赖 `idx_recipient_received_at`
- 富解析缓存当前为 Worker 进程内短 TTL 小容量缓存，不应视为持久缓存
