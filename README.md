# kemail

`kemail` 是一个基于 Cloudflare Workers + D1 + KV 的临时邮箱 API，提供收信存储、邮件查询、管理后台、域名池管理，以及公开 OpenAPI / API 文档页。

仓库采用 [MIT](./LICENSE) 许可证。

## 功能特性

- 入站邮件接收与结构化存储
- 邮件列表、详情、原始 MIME 与富解析能力
- 管理后台与数据看板
- 域名池同步、启停和发号
- 公开 API 文档、OpenAPI 契约和运行时版本入口

## 技术栈

- Cloudflare Workers
- Cloudflare D1
- Cloudflare KV
- 原生 ESM JavaScript
- `mail-parser-wasm-worker` + `postal-mime`

## 项目结构

- `worker.js`：Cloudflare Worker 入口
- `worker/`：后端运行时模块
- `manage-src/`：管理页和文档页源码
- `scripts/build-manage-assets.mjs`：构建本地 `public/` 静态产物
- `scripts/run-worker-regression.mjs`：本地 Worker 集成回归
- [`specs/openapi.json`](./specs/openapi.json)：完整接口契约源
- [`wrangler.demo.toml`](./wrangler.demo.toml)：Wrangler 配置模板

说明：

- `public/` 是构建产物目录，使用 `npm run build:manage` 本地生成
- `wrangler.toml` 请基于 [`wrangler.demo.toml`](./wrangler.demo.toml) 在本地创建

## 环境要求

- Node.js 20+
- npm
- Wrangler CLI
- 一个已接入 Cloudflare 的域名

## 快速开始

### 1. 安装依赖

```bash
npm ci
```

### 2. 准备 Wrangler 配置

```bash
cp wrangler.demo.toml wrangler.toml
```

然后在本地 `wrangler.toml` 中替换以下配置：

- Worker 名称
- D1 数据库 ID
- KV Namespace ID
- 自定义域名或 Route 配置

推荐绑定名称：

- D1 binding：`DB`
- KV binding：`CACHE`
- Assets binding：`ASSETS`

### 3. 初始化 D1

全新安装可执行以下 SQL：

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

如果是旧库升级，至少补跑：

```sql
CREATE INDEX IF NOT EXISTS idx_recipient_received_at
ON emails (recipient, received_at DESC);
```

### 4. 配置 Secrets

```bash
npx wrangler secret put READ_API_KEY
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

变量说明：

- `READ_API_KEY`：对外查询与常规读写流程
- `ADMIN_API_KEY`：后台管理能力
- `CLOUDFLARE_API_TOKEN`：域名池同步使用的 Cloudflare Token

如果暂时不用域名池同步，可以不配置 `CLOUDFLARE_API_TOKEN`。

## 常用命令

```bash
npm run dev
npm run build:manage
npm run test:worker
npm run verify:predeploy
npm run deploy
```

- `npm run dev`：本地开发
- `npm run build:manage`：生成本地 `public/` 静态产物
- `npm run test:worker`：运行 Worker 集成回归
- `npm run verify:predeploy`：构建 + 回归 + `wrangler deploy --dry-run`
- `npm run deploy`：构建 + 回归 + 正式部署

## 部署流程

建议按以下顺序部署：

1. 在本地创建并填写 `wrangler.toml`
2. 执行 D1 建表 SQL
3. 配置 `READ_API_KEY`、`ADMIN_API_KEY`、`CLOUDFLARE_API_TOKEN`
4. 运行 `npm run verify:predeploy`
5. 运行 `npm run deploy`
6. 在 Cloudflare Email Routing 中将目标地址或 catch-all 转发到该 Worker
7. 如需正式对外使用，再绑定自定义域名

## 文档与接口入口

- 公开 API 文档：`/api-docs`
- 公开 OpenAPI：`/openapi.json`
- 公开运行时版本：`/api/version`
- 管理员内部文档：`/api/admin/docs`
- 管理员内部 OpenAPI：`/api/admin/openapi`

更完整的请求与响应结构以 [`specs/openapi.json`](./specs/openapi.json) 和运行中的文档页为准。

## 权限说明

- `READ_API_KEY` 可用于发号、查列表、查详情、查最新邮件、删邮件
- `ADMIN_API_KEY` 额外拥有星标、标记已读、富解析、原始 MIME 与域名池管理能力
- 管理页支持只读密钥登录；只读会话不会展示管理员入口

## 运行时行为

- `POST /api/addresses/generate` 是推荐发号入口
- `GET /api/version` 可公开查看当前线上实例暴露的版本号
- Workers KV 只承担未鉴权 API 的防刷限流
- `/api/latest` 当前直接走 D1 查询，性能依赖 `idx_recipient_received_at`
- 富解析缓存当前为 Worker 进程内短 TTL 小容量缓存，不应视为持久缓存

## 版本

- 仓库版本以 `package.json` 为单一来源
- 线上运行版本可通过 `GET /api/version` 查询
- GitHub 发布基线使用 tag 标记，例如 `v1.0.0`、`v1.1.0`
