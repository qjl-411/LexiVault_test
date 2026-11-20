# 数据库存储说明

数据库负责身份、关系和结构化信息；论文 PDF 与笔记 Markdown 仍是普通本地文件。笔记正文只写入 Markdown 文件，数据库不重复保存正文。

| 文件 | 保存内容 |
| --- | --- |
| `%LOCALAPPDATA%\LexiVault\accounts.sqlite` | 邮箱、验证时间、昵称、Argon2id 密码哈希、会话摘要、用户设置、OpenAlex Key 密文、请求限流与短期验证码摘要 |
| `%LOCALAPPDATA%\LexiVault\app.sqlite` | 本机工作空间登记路径、每个账号打开过的空间及时间、每个账号的当前空间 |
| 每个工作空间下的 `.lexivault/library.sqlite` | 文献元数据、附件与版本、笔记路径与哈希、来源、标签、收藏夹、阅读进度、批注、引用关系和任务状态 |

`--data-dir` 可更改前两个数据库所在目录。工作空间可以放在其他磁盘，数据库使用相对于空间根目录的文件路径。

工作空间 v3 新增 `conversations`、`messages` 和 `assistant_state`，保存该空间的对话、消息和首页状态。v2 升级前同样生成备份，论文和笔记文件不受影响。当前空间由本机登记库按账号记录，不再从旧浏览器示例名称推断。

工作空间 v4 新增 `plans`、`plan_files`、`plan_preferences`。计划正文以磁盘 Markdown 为准，数据库仅保存元数据、路径、哈希与版本；富文本编辑缓存位于工作空间 `.lexivault/plan-docs`，不作为外部正文的替代来源。旧库升级前自动备份。

工作空间 v5 将数据库统一放入 `.lexivault/library.sqlite`，新增 `workspace_settings` 和 `file_trash`。旧根目录数据库会复制到内部目录后迁移，正文不搬动；新空间不预设文档目录，也不自动导入浏览器旧计划。回收站、历史、编辑缓存和升级备份均保存在 `.lexivault` 中。

工作空间表：`documents`、`attachments`、`revisions`、`notes`、`reading_progress`、`source_records`、`annotations`、`note_citations`、`tags`、`document_tags`、`collections`、`collection_items`、`jobs`，另有版本管理表。

文献可先只有标题、作者、年份、摘要和 DOI，后续导入 PDF 时传入文献 ID 补充全文。未获取到全文时，阅读页保留笔记入口并提示补充 PDF。任务表目前只提供持久化和状态流转，尚未实现下载、解析或索引执行器。标签、收藏夹等已有后端接口，完整管理界面待后续接入。

## 账号与部署边界

登录注册页已调用真实本地账号接口。密码使用独立随机盐进行 Argon2id 哈希；会话 Cookie 为 HttpOnly，数据库只存令牌摘要。退出撤销当前会话。设置保存主题和笔记字号。账号数据库不保存论文或笔记。

登录后可以通过“打开工作空间”选择本机目录。`user_workspace_history` 按账号和工作空间保存最近打开时间，`user_workspace_state` 按账号保存当前空间。多个账号可以分别打开同一目录，使用同一份文件、索引、阅读进度和已保存的工作空间对话。

工作空间子接口检查登录状态和当前账号的打开记录。WebSocket 检查同样的条件，并在退出或会话过期后关闭。账号直接访问未打开的空间会收到 404。新建和打开仍检查父子目录重叠及应用配置目录，文件读写由操作系统权限决定。

本机登记库从 v1 或 v2 升级到 v3 前，会备份到配置目录的 `backups/app-v1-时间.sqlite` 或 `backups/app-v2-时间.sqlite`。v3 把旧版 `owner_user_id` 和已记录的当前空间转为相应账号的打开记录。旧字段仅供兼容迁移，`last_user_id` 不参与访问判断。升级修改本机登记库，原工作空间文件留在原目录。

可用 `python -m backend --account-service --host 127.0.0.1 --port 8002` 单独启动账号接口。独立服务的 Cookie 默认要求 HTTPS。本地版账号由本机账号库管理。

## OpenAlex 个人凭据

账号库 v3 新增 `openalex_credentials` 表。旧库在升级前备份为 `backups/accounts-v1-时间.sqlite` 或 `backups/accounts-v2-时间.sqlite`。字段与用户 ID 关联，保存经过身份绑定的 Fernet 密文。每次向 OpenAlex 发起请求时，文献发现后端按登录身份读取该账号的 Key。已绑定状态可在前端显示，Key 明文只由用户提交一次，可随时更换或移除。

本地运行时，首次绑定会在账号数据库同目录生成 `.lexivault-credentials.key`。迁移时需要保存账号数据库及其对应主密钥。部署时可将固定的 Fernet 主密钥注入文献发现后端的 `LEXIVAULT_CREDENTIALS_KEY` 环境变量，并在重启和多实例间使用同一份值。从已有本地库迁移时，使用原主密钥文件中的值。

首次部署且没有既有凭据时，可生成一份新主密钥并保存到部署平台的机密配置。主密钥用于加解密各账号提交的 OpenAlex Key。

```powershell
backend\.venv\Scripts\python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## 邮件验证码

注册和找回密码使用 4 位数字验证码，10 分钟有效，60 秒后可重发。提交错误时可在有效期内重试，服务按邮箱和来源 IP 做请求限流。验证码按邮箱和用途保存带密钥的摘要。注册完成后回到登录页，重置成功后旧登录会话失效。

启动前在运行后端的 PowerShell 窗口配置以下环境变量。使用发信服务提供的 SMTP 授权码，并通过本机环境变量注入。

| 环境变量 | 用途 |
| --- | --- |
| `LEXIVAULT_SMTP_HOST` | 发信服务提供的 SMTP 主机 |
| `LEXIVAULT_SMTP_USER` | SMTP 登录名 |
| `LEXIVAULT_SMTP_PASSWORD` | SMTP 授权码或服务密码 |
| `LEXIVAULT_SMTP_FROM` | 发件地址，省略时使用 SMTP 登录名 |
| `LEXIVAULT_SMTP_SECURITY` | `ssl` 或 `starttls`，默认 `ssl` |
| `LEXIVAULT_SMTP_PORT` | SMTP 端口，按服务填写，默认 SSL 465 或 STARTTLS 587 |
| `LEXIVAULT_EMAIL_CODE_SECRET` | 可选的随机密钥。单进程本地服务可使用启动时生成的密钥，重启后需重新取码。多进程账号服务需设置同一个高强度随机密钥。 |

账号库从 v1 升级到 v2 时备份到 `backups/accounts-v1-时间.sqlite`。旧账号使用原密码登录时会提示补验证邮箱，验证后可以使用邮件找回密码。请先配置发信，再用旧账号完成补验证。

## 升级和备份

首次启动自动创建账号和登记数据库，将旧 `workspaces.json` 导入登记表并保留原 JSON。旧工作空间数据库从 v1 升级到 v2；迁移前生成工作空间 `.lexivault/backups/library-v1-时间.sqlite`，迁移在事务内执行。保留原文献 ID、文件路径、页码和旧引用版本标识，不重写原件或 Markdown 正文。新数据库不需要旧版备份。

也可关闭旧服务后在项目根目录执行：

```powershell
backend\.venv\Scripts\python -X utf8 -m backend.manage status
backend\.venv\Scripts\python -X utf8 -m backend.manage upgrade
```

备份整个资料库时应关闭服务并复制整个工作空间；只备份数据库不包含论文和笔记。账号和本机登记数据库需要另行备份。数据库回退前先停止服务并保留当前文件副本，同时使用与旧结构兼容的程序版本。

## 使用 Navicat 查看

创建 SQLite 连接，选择上述 `.sqlite` 文件即可，无需安装 MySQL。建议只查看数据，通过应用接口修改，以保持版本、关联和本地文件一致。密码字段只能看到哈希，不能还原原始密码。

arXiv 获取记录包含来源版本 ID 与来源页。可用 PDF 与题录一起入库。下载失败时可保留题录，后续重新获取或由阅读页为同一条目补充 PDF，原笔记仍与该条目关联。
