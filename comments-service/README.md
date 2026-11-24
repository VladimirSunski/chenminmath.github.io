# Blog 评论区：发布草稿

本草稿把评论表单接入现有 GitHub Pages 博文；正文、标题和 Blog 列表均不改写。
评论后台独立部署在 Cloudflare Workers，数据存入你的 Cloudflare D1 数据库。
**草稿 PR 不会启用线上评论；`assets/js/comments-config.js` 默认留空。**

## 读者与作者的使用流程

1. 读者在博文底部填写公开昵称与评论，无需注册；完成 Turnstile 防垃圾验证。
2. 提交后看到“等待审核”。数据库状态固定为 `pending`，公开接口查询不到这条评论。
3. 你访问 `https://<你的 Worker 地址>/admin`，输入管理密钥，查看“待审核”列表。
4. 点击“批准发布”后评论才对外可见；“拒绝发布”使其继续不公开。
5. 在“已发布”列表中，以 Chenmin Sun 身份填写并发布作者回复。可多次回复。
6. 如需撤回，点击“隐藏评论”，该评论及其全部作者回复立即从公开接口隐藏。
7. “永久删除”删除评论及其全部回复，并要求在界面确认。退出后台会清空当前页面持有的密钥。

读者昵称是自由填写的，不是认证身份；只有后台生成的回复有“Author”标记。
本版本提供读者顶层评论和作者回复，不提供读者直接发布回复的入口；读者再次留言仍须审核。
没有邮件通知或邮件采集。你在后台手动刷新审核队列。

## 正式启用前需要配置

需要你名下的 Cloudflare 账号、一个 Worker、一个 D1 数据库、一个 Turnstile widget。
GitHub Pages 不能自行运行数据库或私密审核后台，因此这部分不能仅靠合并 PR 完成。
本仓库不包含任何真实管理密钥、Cloudflare 凭据或真实评论数据。

以下操作在克隆仓库后的 `comments-service/` 目录执行。Node.js 24 可直接运行测试。
Wrangler 是 Cloudflare 的部署命令行；这里使用 `npx`，无需全局安装。

### 1. 登录并创建数据库

```sh
cd comments-service
npx wrangler login
npx wrangler d1 create chenmin-blog-comments
```

将返回的 `database_id` 填入 `wrangler.toml` 对应位置；不要复制任何账户访问令牌。
保留 `DB` 绑定名，并按你的实际 Blog 域名设置 `SITE_ORIGIN`。
当前仓库对应的默认源为 `https://vladimirsunski.github.io`（只写源，不带路径和末尾斜杠）。
如果网站以后改用自定义域名，需同时修改此项和下面的 Turnstile 主机名。

```sh
npx wrangler d1 migrations apply chenmin-blog-comments --remote
```

### 2. 配置 Turnstile

在 Cloudflare 控制台创建 Managed Turnstile widget，允许主机名 `vladimirsunski.github.io`。
将公开 Site Key 填入 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`。
Secret Key 只能用下面的命令录入，不要提交到仓库：

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
```

### 3. 设置后台管理密钥

用密码管理器生成至少 32 随机字节对应的长密钥（例如 64 位随机十六进制串），保存到你的密码管理器。
运行下列命令，在交互提示中输入它：

```sh
npx wrangler secret put ADMIN_TOKEN
```

这也是你以后登录 `/admin` 时输入的密钥。密钥不写入前端、不放进 URL、Cookie、localStorage 或 sessionStorage。
不要在聊天、PR、GitHub 文件或 Actions 日志里粘贴密钥。若泄露，重新运行此命令轮换密钥，旧密钥随即失效。
刷新后台页面后须重新输入。所有管理 API 都在服务端检查密钥，隐藏页面地址本身不是权限控制。

### 4. 部署后台并核查

```sh
npm test
npx wrangler deploy
```

记录 Wrangler 返回的 HTTPS Worker 地址。
先访问 `/admin` 登录，确认空审核队列可读取；确认未登录访问 `/api/admin/comments` 得到 401。
不要把生产管理密钥用在公开演示或测试脚本中。

### 5. 接通 Blog 并正式发布

将 `assets/js/comments-config.js` 改为（替换为真实 Worker 地址）：

```js
window.BLOG_COMMENTS = Object.freeze({
  apiBase: 'https://chenmin-blog-comments.<你的子域名>.workers.dev'
});
```

在正式网站上走一次真实流程：提交评论 → 确认公开页面不可见 → 后台批准 → 刷新后可见 → 作者回复 → 隐藏后不可见。
浏览器自动化使用模拟 Turnstile，不能代替这一步真实 Cloudflare 联调。
确认后再合并并发布；后端账号配置和正式启用属于后续步骤。
如果希望在独立预览域名先联调，请使用独立测试数据库和相应的域名配置，勿复用生产数据。

## 实现与数据边界

- `worker.mjs`：公开评论接口、匿名提交、审核 API、鉴权、限流、定时清理。
- `admin-page.mjs`：后台页面和交互，审核界面为中文，读者界面为英文以匹配现有 Blog。
- `migrations/0001_comments.sql`：评论、作者回复、短期限流摘要及验证码使用摘要。
- `posts.mjs`：允许评论的文章白名单。以后新增文章时需添加 slug，并在文章 HTML 中接入评论组件。
- `../assets/js/comments*.js` 与 `../assets/css/comments.css`：读者评论区。地址未配置时保持隐藏。
- 评论和回复按纯文本显示，HTML 不会执行；不支持 HTML/Markdown 富文本或附件。
- 服务端一律将新评论设为待审，读者无法指定已发布状态或伪造作者回复。
- 公开列表每页最多 50 条，仅查询当前文章的已批准记录，支持继续加载；页面刷新后显示最新批准与回复。
- 评论数据库不公开同步到 GitHub；未审核内容不会进公开仓库、公开 Issues、GitHub Pages 构建文件或公开接口。
- 数据库不存邮箱和原始 IP。Cloudflare 会处理网络请求和验证码数据；页面提示有对应的隐私政策链接。
- 评论和回复保留至你手动永久删除；限流摘要保留至多约七天，验证码使用摘要至多约一天后由小时任务清理。
- 每个来源地址每小时最多 5 次提交尝试；全局每天最多 1,000 条通过验证的提交；管理接口每来源每 15 分钟最多 200 次请求。
- 公开接口使用明确允许的源；后台通过同源页面调用，权限密钥不通过跨站 Cookie 传递。响应不缓存。
- 配置缺失或验证码服务失败时拒绝提交，不能绕过审核。

## 测试

```sh
cd comments-service
npm test
```

使用 Node 内置测试框架与真实 SQLite 执行迁移及 SQL，不依赖额外 npm 包。
覆盖待审不可见、权限校验、批准、拒绝、隐藏、删除连带回复、作者标记、文章隔离、分页、跨站限制、输入长度、SQL 注入文本、验证码校验/重放与限流。

可选浏览器完整流程测试（不连接生产服务）：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
```

浏览器测试运行真实页面脚本及后台处理逻辑，数据库为测试内存库，模拟验证码验证服务。
测试密钥是固定的 `TEST-ONLY` 数据，不是可使用的生产凭据。
GitHub Actions 会分别运行后台测试与 Chromium 流程测试。

## 运维

用 Cloudflare 控制台或 D1 导出功能定期备份数据库。按评论量检查所选账号的服务额度。
不记录请求正文、管理密钥和验证码 token；不要在故障排查时添加这些日志。
若需暂停新提交，将前端 `apiBase` 清空并发布；若需停止直接 API 提交，也须在后台移除/禁用 Turnstile Secret。

官方参考：
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
