
# 家藏万卷

一个面向家庭场景的私有藏书管理系统，支持成都 / 重庆两地分类、全文搜索、ISBN 扫码录入、增删改查，以及 iPhone 添加到主屏后的类 App 使用方式。

当前仓库已经脱离 Firebase 运行时依赖：

- 本地快速测试模式使用浏览器 localStorage，不依赖任何线上服务。
- 生产部署目标是 Cloudflare Workers + Workers Static Assets + D1。
- 生产登录由 Cloudflare Zero Trust Access 统一处理，站内不再维护用户名密码。

## 当前能力

- 查看全部藏书，或按成都 / 重庆筛选。
- 按书名、作者、ISBN 搜索。
- 手动新增、编辑、删除书籍。
- 上传书籍封面图片，并存入 Cloudflare R2。
- 使用摄像头扫描 ISBN，并尝试通过 Google Books / Open Library 自动补齐信息。
- 本地开发模式可直接测试完整前端交互。
- 生产架构已接好 Cloudflare API、D1 和 R2 封面存储。

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 创建本地环境变量

```bash
cp .env.example .env.local
```

默认情况下，`.env.example` 已经配置为本地测试模式：

```env
VITE_DATA_MODE="local"
VITE_DEV_ACCESS_EMAIL="local@home-library.dev"
```

这意味着：

- 页面直接使用 localStorage 保存书籍数据。
- 页面会显示一个本地开发身份，不需要登录。
- 你可以马上测试查看、搜索、添加、编辑、删除和扫码录入。

### 3. 启动开发服务器

```bash
npm run dev
```

打开 `http://127.0.0.1:3000` 或 `http://localhost:3000`。

### 4. 本地测试说明

- 图书数据存放在当前浏览器的 localStorage 中。
- 清空浏览器站点数据后，书库会被清空。
- ISBN 自动补全仍然会访问外部公开 API，所以这一项依赖网络。
- 封面上传不会写入 localStorage；如需测试上传到 R2，请改用 API 模式并启动 Worker。

## Cloudflare 生产技术栈

推荐使用以下组合：

- Cloudflare Workers：承载 `/api/session`、`/api/books` 等接口。
- Cloudflare Workers Static Assets：托管前端静态资源与 SPA 路由回退。
- Cloudflare D1：存储书籍数据。
- Cloudflare R2：存储用户上传的书籍封面图片。
- Cloudflare Zero Trust Access：保护整个站点，只允许两位固定用户访问。
- Cloudflare DNS：接入你现有的独立域名。

当前实现会优先显示 R2 中的封面图片。历史外链封面仍可兼容显示，但前端已经不再提供录入外链 URL 的入口。

## 为什么登录直接交给 Zero Trust

你的用户只有两个人，而且站点没有公开使用计划。对这种场景，最合适的做法不是再在站内维护一套用户名密码，而是：

- 让整个站点先经过 Cloudflare Access。
- Access 只放行两个指定邮箱。
- 前端和 API 都只处理“已通过 Access 的用户”。

这样做的好处是：

- 少一套密码库和重置密码流程。
- 站点天然私有，外部无法直接访问。
- 会话时长可以设置得很长，比如 30 天，避免频繁登录。

## Cloudflare 部署步骤

### 1. 将域名接入 Cloudflare

把你的独立域名托管到 Cloudflare DNS。建议为本项目单独准备一个子域名，例如：

- `library.example.com`

### 2. 配置 Wrangler 与 Worker

本仓库已经提供 Worker 配置文件 [wrangler.jsonc](wrangler.jsonc)。关键配置如下：

- `main`: `worker/index.ts`
- `assets.directory`: `dist`
- `assets.not_found_handling`: `single-page-application`
- `assets.run_worker_first`: `['/api/*']`

首次部署前，请把 [wrangler.jsonc](wrangler.jsonc) 里的 `database_id` 从 `TODO_REPLACE_WITH_D1_DATABASE_ID` 改成你自己的 D1 数据库 ID。

### 3. 创建 D1 数据库

在 Cloudflare Dashboard 里创建一个 D1 数据库，例如：

- Database name: `home-library`

然后把它绑定到 Worker，绑定名使用：

- `DB`

本仓库已经提供了数据库迁移脚本，见 [migrations/0001_init.sql](migrations/0001_init.sql) 和 [migrations/0002_add_cover_object_key.sql](migrations/0002_add_cover_object_key.sql)。

初始化数据库示例：

```bash
npx wrangler d1 migrations apply home-library --remote
```

### 4. 创建 R2 存储桶

在 Cloudflare Dashboard 中创建一个 R2 bucket，例如：

- Bucket name: `home-library-covers`

然后把 [wrangler.jsonc](wrangler.jsonc) 里的以下字段替换成你自己的桶名：

- `r2_buckets[0].bucket_name`
- `r2_buckets[0].preview_bucket_name`

绑定名请保持为：

- `BOOK_COVERS`

当前实现通过 Worker 的 `/api/covers/*` 路由回读图片，所以 R2 bucket 不需要额外配置公网公开访问。

### 5. 配置 Worker 环境变量

在 Cloudflare Worker 的 Variables / Secrets 中添加：

- `TEAM_DOMAIN`：你的 Zero Trust team 域名，例如 `https://your-team.cloudflareaccess.com`
- `POLICY_AUD`：目标 Access 应用的 AUD tag
- `ALLOW_DEV_AUTH`：生产环境不要设置为 `true`
- `DEV_ACCESS_EMAIL`：仅本地或预览联调用，可选

如果你使用 Wrangler CLI，也可以用 `wrangler secret put` 写入敏感值。

### 6. 配置 Zero Trust Access

在 Cloudflare Zero Trust 里创建一个 Self-hosted Web Application：

- Application type: Self-hosted
- Application domain: `library.example.com`
- Path: `/*`

推荐登录方式：

- Email One-Time PIN

推荐策略：

- Allow：只允许两个固定邮箱
- Session duration：`1 month`

不推荐本项目使用 Google OAuth 作为唯一入口，因为你的使用环境包含中国大陆，邮箱 OTP 的可用性通常更稳妥。

### 7. 部署 Worker

仓库已经在 [wrangler.jsonc](wrangler.jsonc) 中配置了构建命令，所以可以直接部署：

```bash
npm run deploy
```

或者：

```bash
npx wrangler deploy
```

### 8. 将自定义域名绑定到 Worker

此处可以在 Worker 的 Settings 中添加自定义域名，然后它会自动将这个域名绑定到这个 DNS 记录中。

## 生产环境的认证流

### 页面访问

1. 用户先访问 `library.example.com`
2. Cloudflare Access 判断是否在允许名单内
3. Access 认证通过后，才会把请求转发到 Worker
4. Worker 再校验 `Cf-Access-Jwt-Assertion`
5. API 从 JWT 中提取邮箱，作为当前操作用户

### 应用内表现

- 生产环境不会再出现站内登录按钮。
- 如果 Access 没有正确配置，前端会显示“访问受保护”的提示页。
- “退出登录”会跳转到 Cloudflare Access 的退出地址。

## 本地模式与生产模式的区别

### 本地模式

- 由 `VITE_DATA_MODE=local` 控制。
- 数据存储在浏览器 localStorage。
- 适合快速验证界面、交互和数据流。

### API 模式

- 由 `VITE_DATA_MODE=api` 控制。
- 前端调用 `/api/session`、`/api/books` 与 `/api/covers`。
- 适合接 Cloudflare Worker、D1 和 R2。

如果你本地已经跑起了 Cloudflare Worker 开发服务，还可以设置：

```env
VITE_API_PROXY_TARGET="http://127.0.0.1:8788"
VITE_DATA_MODE="api"
```

这样 Vite 会把 `/api` 请求代理给本地 Worker 服务。

对应的本地 Worker 命令：

```bash
npm run worker:dev
```

如果你要验证封面上传，请确保本地 Worker 也已经拿到了 `BOOK_COVERS` 绑定，否则 `/api/covers` 会返回配置错误。

## 项目结构

- [src/App.tsx](src/App.tsx)：主界面与交互。
- [src/lib/library.ts](src/lib/library.ts)：本地存储 / API 双模式数据层。
- [worker/index.ts](worker/index.ts)：Cloudflare Worker API 入口。
- [wrangler.jsonc](wrangler.jsonc)：Worker 构建、静态资源和 D1 绑定配置。
- [migrations/](migrations/)：D1 数据库迁移脚本。
- [public/manifest.webmanifest](public/manifest.webmanifest)：PWA manifest。
- [public/sw.js](public/sw.js)：最小化 service worker。

## 中国大陆访问说明

本项目当前采用的是“可日常访问的 best-effort”目标，而不是“中国大陆网络质量强保证”目标。

这意味着：

- 使用 Cloudflare 全球网络，通常可以从国内访问。
- 不额外引入中国大陆专线或 ICP 方案。
- 不承诺在所有网络环境下都达到稳定低延迟。

如果未来你要把“中国大陆稳定访问”提升为硬要求，就需要额外评估 ICP、接入方式与合规问题，那会是单独一轮工作。

## 已知非目标

- 不提供公开注册。
- 不在站内维护用户名密码体系。
- 不做完整离线写入同步。

## 验证清单

完成部署后，至少检查以下几项：

1. 站点未通过 Access 时无法进入。
2. 两个白名单邮箱都能正常登录。
3. 可以查看、搜索、添加、编辑、删除书籍。
4. 可以上传、替换、删除封面，并确认图片实际写入 R2。
5. ISBN 扫码录入在 iPhone Safari 中可正常拉起摄像头。
6. 添加到主屏幕后能以 standalone 方式打开。
