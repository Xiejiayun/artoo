# Azure + Supabase Web Implementation Plan

> 本轮交付范围是方案和资源操作文档。以下复选框留给下一次接入实施；不表示代码已经实现或云端已经部署。

**Goal:** 将可信团队版 Artoo 部署到 Azure 单台 Linux VM，直接使用 Google 登录，业务数据存入 Supabase PostgreSQL，并能迁到 Azure PostgreSQL。

**Architecture:** 保留同源 Web/API/auth/WebSocket 和单服务实例。通过现有 `DbClient` 接口增加标准 PostgreSQL 驱动；Google 继续直接 OIDC；文件产物继续存 Azure 持久磁盘。Supabase 只作为数据库供应方。

**Tech Stack:** Node.js 24+、npm 11+、Fastify、React/Vite、Drizzle、node-postgres (`pg`)、PostgreSQL、Caddy 2、systemd。

## Global Constraints

- 资源创建步骤和参数来源见[操作方案](../../azure-supabase-deployment.md)，优先复用现有 Azure Ubuntu VM。
- 本轮不创建/启动付费资源，不更换现有数据库，不修改产品行为；后续执行前确认实际目标 VM、域名及密钥文件。
- Google 直接登录，Supabase 不承担 Auth、Realtime、Storage 或浏览器数据访问；首版关闭 Data API。
- 一个可信团队、一个 Artoo 服务实例；保持单写者语义，不宣称远程数据库带来多副本支持。
- 迁移角色和运行角色分离；TLS 验证 CA 和主机名；配置错误必须拒绝启动，不静默回退到 PGlite。
- 不修改历史迁移 SQL/checksum；保留 `public` 和 `artoo_meta`。PGlite 继续支持本地开发和现有测试。
- 不提交真实密钥/邮箱名单/连接串。不改动其他工作区中尚未提交的功能修改。

## 当前依据

| 能力 | 当前实现 | 后续工作 |
| --- | --- | --- |
| 数据库接口 | `packages/storage/src/db/db-client.ts` 已有 `DbClient` | 新增 PG 实现，当前只有 PGlite |
| 生产入口 | `apps/server/src/main.ts` 直接创建 PGlite，并启动时迁移 | 显式选驱动，远程 PG 启动只核验版本 |
| 迁移日志 | `pglite-db-client.ts` 对历史逐条 checksum | PG 保留规则并增加事务级迁移锁 |
| 实时事件 | `eventLog.position` + `position > cursor` | 验证 PG 连接并发语义，避免乱序提交漏事件 |
| Google 登录 | `apps/server/src/auth/` 已有完整 OIDC | 真实 Google 配置/验收，补 issuer 兼容 |
| Web 资源 | Vite `base: "./"`，浏览器用 BrowserRouter | 修复 `/channels/` 资源路径，保留 Electron file:// 能力 |
| 服务模板 | `deploy/artoo-preview.service`、`deploy/Caddyfile` | 文档化数据盘依赖、环境和正式域名 |
| 备份工具 | `storage-operations.ts` / `storage.mjs` 仅适用 PGlite | 独立 PG dump/restore + 文件产物备份 |

## Task 1: PostgreSQL 驱动与配置

**Files:**
- Create: `packages/storage/src/db/postgres-db-client.ts`
- Create: `packages/storage/src/db/postgres-db-client.test.ts`
- Create: `apps/server/src/config/database.ts`
- Create: `apps/server/src/config/database.test.ts`
- Modify: `packages/storage/package.json`, `package-lock.json`, `packages/storage/src/index.ts`, `apps/server/src/main.ts`, `.env.example`

**Interfaces:**
- 实现现有 `DbClient` 的 `db`、`transaction<T>()`、`migrate()`、`healthCheck()`、`close()`，业务服务不直接依赖 `pg.Pool`。
- 新工厂 `createDatabaseClient(env)` 返回 `Promise<DbClient>`；读取 `DATABASE_URL` 和可选 `DATABASE_SSL_CA_FILE`。
- `DATABASE_URL` 缺省时保留明确的本地 PGlite 模式；一旦提供 PG 配置，其缺失/无效/连接失败不得降级。远程 PG 与 `ARTOO_DB_DIR` 同时设置时拒绝歧义。

- [ ] 增加 `pg`、对应类型以及 `drizzle-orm/node-postgres` 驱动接入。
- [ ] 配置测试覆盖：空值/非法 URL、冲突的本地路径、CA 文件缺失、错误主机名/CA、错误数据库凭据、连接断开后的失败行为。
- [ ] 初版应用查询池固定 `max: 1`，所有业务查询和事务使用该池；排查事务回调内绕过 `tx` 再取连接造成的死锁。单连接不是免除真实 PG 并发测试的理由。
- [ ] `close()` 等待业务连接释放；数据库故障导致 ready 不通过，日志只显示脱敏 host/driver，不输出密码或完整 URL。
- [ ] 以环境注入的专用一次性 PostgreSQL 数据库运行真实集成测试；显式集成模式没有数据库时失败，不能静默跳过并报告上线通过。测试不得连接用户生产库。

验证：新增配置测试全部通过；真实 PG 完成事务提交/回滚、健康检查和重复关闭；原 PGlite 测试继续通过；`npm run typecheck`、`npm run build:preview` 通过。

## Task 2: 独立迁移、角色授权和单实例约束

**Files:**
- Create: `scripts/migrate-postgres.mjs`, `deploy/postgres/bootstrap-roles.sql`
- Create: `apps/server/src/database-migration.test.ts`, `apps/server/src/database-singleton.test.ts`
- Modify: `packages/storage/src/db/postgres-db-client.ts`, `apps/server/src/config/database.ts`, `apps/server/src/main.ts`, `package.json`

**Interfaces:**
- `npm run db:migrate` 调用新迁移命令；只读独立 `MIGRATION_DATABASE_URL` 和 TLS 配置。
- PG 客户端提供迁移版本校验；远程 PG 的正常服务启动只校验，DDL 由专用命令执行。`migrate(statements)` 保留供迁移命令调用。
- 初始化脚本创建 `artoo_migrator`、`artoo_app` 和 `artoo_meta`，按操作方案授权；密码通过安全交互/外置凭据设定，不出现在 SQL 文件中。

- [ ] PG 迁移在同一事务中获取固定的应用迁移 advisory lock、校验 journal、应用新增 DDL、写入 checksum。对改变历史、缺号、数据库比代码新、已有未追踪业务表的情况明确失败。
- [ ] 先验证应用角色不能迁移/删表，再验证它能读写业务表/序列并只读 journal。迁移角色拥有所创建对象，两个角色都不拥有超管或创建角色能力。
- [ ] 初始化脚本区分首次建库和恢复准备：恢复前只创建角色/数据库，不提前创建归档内的 schema/业务表，恢复角色拥有专用新目标和默认 `public` schema；清理恢复仅允许已验证的空目标，并在单事务中执行，恢复后再补应用授权。备份角色具备 schema USAGE、应用表 SELECT、应用序列 SELECT 及对应默认权限。
- [ ] 撤销 `anon`/`authenticated` 对应用对象的现有与默认权限；校验独立 Supabase 项目已关闭 Data API，不依赖默认 RLS 保护服务端 schema。
- [ ] 服务用独立持久连接获取 session advisory singleton lock，必须在 schema 初始化、seed 和节点恢复之前成功；锁连接失败/断开时停止服务，防止失锁后继续写入。
- [ ] 迁移命令也获取相同的 singleton lock，拒绝与运行中的服务或另一个迁移进程重叠。直连/Session pooler 支持此语义，Transaction pooler 不作为本方案支持配置。
- [ ] 保留初版单实例/应用池单连接；运维脚本在维护窗口运行，不从第二个进程修改业务表。

验证：空库迁移、重复执行、追加迁移、失败回滚、历史变更拒绝；应用角色正常启动但不能 DDL；第二实例失败且不触发节点恢复；服务与迁移互斥；锁连接断开触发停服。

## Task 3: PostgreSQL 上的业务一致性验收

**Files:**
- Create: `apps/server/src/postgres-integration.test.ts`
- Review: `packages/db/src/event-writer.ts`, `packages/db/src/idempotency.ts`, `apps/server/src/ws/event-publisher.ts`, `apps/server/src/app.ts`
- Modify only if a test exposes a defect in those paths.

**Interfaces:** 通过 Task 1 工厂/真实 PG 测试实例调用既有 HTTP 和 WebSocket 接口；不为测试新增生产鉴权绕过接口。

- [ ] 用不同请求交错触发任务、消息和审核事务，验证所有成功提交的事件都在实时流及断线补发中出现，失败事务的事件不可见。
- [ ] 验证较早分配的 `bigserial` 不能在游标越过它之后才提交；初版通过单连接约束保留串行语义，后续放宽连接数必须先引入经过测试的提交排序方案。
- [ ] 同一幂等键并发请求只写入一次；冲突请求体返回既有冲突结果；事务内服务调用不发生取连接死锁。
- [ ] 验证重启恢复、seed 不重复、OAuth 会话和配对身份持久保存；数据库暂时不可用时错误可诊断。

验证：在真实 PostgreSQL 上跑上述用例，并对 Session pooler 完成至少一遍连接、迁移和重启流程；现有只使用 PGlite 的结果不能替代此项。

## Task 4: Web 路由与直接 Google 登录

**Files:**
- Modify: `apps/web/vite.config.ts`, `apps/server/src/auth/oidc-client.ts`
- Review / Modify as needed: `apps/desktop/scripts/` 中复制 Web renderer 的构建入口
- Extend: `apps/server/src/auth/oidc-client.test.ts`, `apps/server/src/auth/oidc-security.test.ts`
- Add built-artifact navigation coverage to `apps/web/e2e-auth/` using `apps/web/playwright.authority.config.ts`.

**Interfaces:** 保持 `/auth/google/start`、`/auth/google/callback` 和 cookie 会话接口，继续使用 `npm run build:preview`；不引入 Supabase Auth。

- [ ] 浏览器构建使用正确的根资源路径，或服务端规范化尾斜杠导航；若调整 Vite base，明确区分 Web 和 Electron 构建，不能破坏桌面的相对 file:// 资源加载。
- [ ] 验证正式构建的 `/`、`/channels`、`/channels/` 直接导航/刷新时 HTML、JS、CSS 都成功，并检查桌面构建资源可加载；仅检查 fallback 返回 200 不够。
- [ ] 仅当配置的 issuer 是 Google 时接受 `https://accounts.google.com` 和 `accounts.google.com` 两种 Google 官方 issuer；自定义/测试 issuer 继续严格匹配。签名、audience、nonce、有效期校验保持生效。
- [ ] 回归测试覆盖两个合法 Google issuer、非 Google 相似字符串拒绝、自定义 issuer 不被放宽，以及现有 PKCE/state/一次性回调逻辑。
- [ ] 根据操作方案配置真实 Web OAuth Client、精确回调、允许邮箱和 Owner，完成真实允许/拒绝登录、刷新、退出及 socket 撤销。

验证命令：

```bash
npm test -- apps/server/src/auth/auth-config.test.ts apps/server/src/auth/oidc-security.test.ts apps/server/src/auth/oidc-client.test.ts apps/server/src/auth/auth-service.test.ts apps/server/src/auth/auth-routes.test.ts
npm run build:preview
```

在 `apps/web` 中运行 `npx playwright test --config=playwright.authority.config.ts` 验证构建后的同源服务；该 fixture 仍不等同于真实 Google 登录，真实回调单独保留结果。

## Task 5: VM 发布、备份与供应方迁移演练

**Files:**
- Extend: `docs/azure-supabase-deployment.md`, `.env.example`
- Create: `deploy/backup/` 下的 PG service 配置示例、备份脚本和 systemd timer/service
- Review: `deploy/artoo-preview.service`, `deploy/Caddyfile`

**Interfaces:** 备份使用 `pg_dump/pg_restore` 和文件归档；现有 `storage.mjs` 继续只服务 PGlite。备份脚本消费受限 PG service/password 文件和 VM 身份，不把密码/存储密钥放进参数。

- [ ] 在用户确认的 VM 配置数据盘、挂载依赖、Node 24、Caddy、受限环境文件和单实例 systemd；DNS/实际出网/IP 白名单逐项核验。
- [ ] 备份脚本等待维护窗口，停止服务写入，归档 `public` + `artoo_meta` 及 artifacts，计算校验和、记录 commit/PG 版本，上传私有 Blob；失败返回非零并产生可见告警，按步骤恢复服务。
- [ ] 用 VM Managed Identity 获取容器范围权限；设置保留规则并测试备份失败与磁盘空间不足不会被报告为成功。
- [ ] 从备份恢复到新 PostgreSQL 库/新文件目录，验证迁移日志、权限、序列、用户身份、消息和产物字节；不覆盖原生产库。
- [ ] 在选择 Azure PostgreSQL 时实际试恢复；正式切换停写、最终备份、恢复、更新连接和 CA、验收再开放。目标产生新写入后回退需保留并同步新数据。
- [ ] 更新文档的“待实现”标签为对应 commit 和真实证据。只有第 7 节公网验收全部完成，才标记部署完成。

## 方案自检

- [x] 分清已有代码、可先创建的资源和未实现的 PostgreSQL 适配。
- [x] 资源方案覆盖 VM/DNS/TLS、Google 客户端、Supabase 连接/权限和实际网络可达性。
- [x] 迁移保留独立身份与标准 PostgreSQL，包含附件、序列、journal、角色和回退边界。
- [x] 验收覆盖真实数据库并发、单实例、真实登录、WebSocket、重启和独立恢复。
- [x] 本轮只提交文档，不把测试身份或本地测试结果当成上线证明。
