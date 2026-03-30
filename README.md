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
- `worker/text-core.js` / `worker/text-links.js` / `worker/text-link-*.js` / `worker/text-logging.js`：文本规范化、链接提取、URL 解包、日志脱敏等内部文本子模块
- `manage-src/`：管理页和文档页源码
- `scripts/build-manage-assets.mjs`：构建本地 `public/` 静态产物
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

- `READ_API_KEY`：发号、消费最新地址邮件、显式删除与标记已读
- `ADMIN_API_KEY`：额外拥有星标、富解析、原始 MIME 与域名池管理能力
- `CLOUDFLARE_API_TOKEN`：域名池同步使用的 Cloudflare Token

如果暂时不用域名池同步，可以不配置 `CLOUDFLARE_API_TOKEN`。

## 常用命令

```bash
npm run dev
npm run build:manage
npm run verify:predeploy
npm run deploy
```

- `npm run dev`：本地开发
- `npm run build:manage`：生成本地 `public/` 静态产物
- `npm run verify:predeploy`：构建 + `wrangler deploy --dry-run`
- `npm run deploy`：构建 + 正式部署

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
- 运行时版本检查：`/api/version`
- 管理员内部 OpenAPI：`/api/admin/openapi`

说明：

- 公开 `/api-docs` / `/openapi.json` 只保留推荐给第三方自动化和 AI 的两步主链：发号、消费最新地址邮件
- 管理页现在内置“文档中心”视图；只读密钥可查看公开接口，管理员密钥可在公开/内部接口之间切换；这是当前后台查看文档的主入口
- `GET /api/latest`、`GET /api/emails`、详情读取、显式删除、批量标已读等高级接口仍保留实现，但主要放在内部/管理员文档中
- `GET /api/version` 仍保留为运行时发布校验入口，但不再放入公开 OpenAPI 契约
- 更完整的请求与响应结构以 [`specs/openapi.json`](./specs/openapi.json) 和运行中的文档页为准

## 权限说明

- `READ_API_KEY` 可用于发号、消费最新地址邮件、显式删除与标记已读
- `ADMIN_API_KEY` 额外拥有星标、富解析、原始 MIME 与域名池管理能力
- 管理页支持只读密钥登录；只读会话不会展示管理员入口

## 运行时行为

- `POST /api/addresses/generate` 是推荐发号入口
- `POST /api/latest/consume` 是推荐的验证码消费入口；默认只匹配最新地址未读邮件，可选择 `peek`、`mark_read` 或 `delete`
- `GET /api/version` 仅用于手工确认线上实例当前跑的是哪一版，不属于公开主链契约
- Workers KV 只承担未鉴权 API 的防刷限流
- 已鉴权请求按 read / write / analysis / rich 四类走 Worker 进程内限流，不再持续写入 Workers KV
- `/api/latest` 当前直接走 D1 查询，性能依赖 `idx_recipient_received_at`
- `GET /api/latest`、`GET /api/emails` 与详情/删除/批量标已读等接口仍保留，主要用于内部调试、管理端和高级脚本
- 富解析缓存当前为 Worker 进程内短 TTL 小容量缓存，不应视为持久缓存
