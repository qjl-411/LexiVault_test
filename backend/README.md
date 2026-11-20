# 本地文献阅读后端

Python 3.12 + FastAPI + SQLite + pypdf + watchfiles。与现有前端同源运行，只监听 `127.0.0.1`。

## 已实现

- 研究计划正文直接读写工作空间 Markdown 文件，附件保留原件；SQLite 保存元数据、路径和版本。

- 登录后使用，支持退出、Argon2id 密码哈希、会话撤销和用户偏好持久化。每个账号分别记录打开过的空间和当前空间。
- 分离账号、工作空间登记和文献数据库；旧空间自动备份迁移，详见 [数据库说明](DATABASE.md)。
- 文献元数据可先入库再补全文；来源、标签、收藏夹、批注、引用和任务状态提供持久化接口。

- 创建／登记工作空间，系统目录选择窗口，重启恢复工作空间列表。
- PDF 上传、大小和格式检查、独立子进程校验（30 秒超时）、字节级去重、原件保留。
- 文献列表、原件读取、文件版本校验、阅读页码持久保存。
- 一篇论文对应一份 UTF-8 Markdown 笔记。暂停输入约 700ms 后保存，也可立即保存。
- 写临时文件再替换，写入前检查内容哈希；冲突返回 409，保留当前草稿，支持保存独立副本和下载草稿。
- 文件监听和 WebSocket 通知；断线重连，5 秒轮询作为页面刷新兜底。
- 运行期间检测到的外部变化与应用保存前版本留存历史快照，界面可载入历史版本为草稿。
- 浏览器本地应急草稿用于刷新恢复，正常笔记正文以磁盘 Markdown 为准。

## 本地数据与文件规则

默认配置登记目录为 `%LOCALAPPDATA%\LexiVault`，`--data-dir` 可覆盖；通过“新建”生成的空间在该目录的 `workspaces/<随机ID>/`。用“打开本地目录”或 `--workspace` 可把资料放在自己选定的目录。

新工作空间只创建 `.lexivault/`。下面的课题目录、PDF 和 Markdown 都由用户自行创建或导入：

```text
工作空间/
  .lexivault/
    library.sqlite
    plan-docs/
    history/
  我的课题/                 用户创建的示例目录
    论文.pdf
    阅读笔记.md
    研究安排.md
```

“知识库管理”和研究计划左栏共用真实文件树，可新建、导入、重命名、移动和删除。删除使用系统回收站（Windows 使用 IFileOperation），恢复通过电脑回收站操作；移回原位置后自动识别。系统回收站不可用时返回失败，不降级为永久删除。需要安装更新后的 requirements.txt（Send2Trash，Windows 另含 pywin32）。PDF 导入接受相对 `directory`，保留原文件名，重名追加数字；外部放入的 PDF 会自动校验并加入文献列表。打开论文不会创建笔记，首次保存时选择 `.md` 路径，或关联已有 Markdown。笔记与计划可在整个工作空间中移动。笔记头的 `lexivault_plan`、`lexivault_document` 用于保持关联，请保留；重复身份会阻止覆盖。外部新增 Markdown 可直接在研究计划页编辑。

PDF 的版本使用原件 SHA-256，页码从文件第 1 页开始。原件被外部替换会拒绝继续按旧版本读取，请将新版本单独导入。原件被删除时，笔记仍保留。

历史快照界面最多列出最近 50 份，磁盘历史暂不自动删除。服务关闭期间的中间修改无法逐次留存；文件监听、历史快照和应急草稿都不能代替完整备份。关闭服务后可复制整个工作空间作为备份，不能只复制 SQLite 文件而遗漏原件与笔记。

外部程序不受本服务写锁控制。保存时进行版本检查与替换前复核，常见冲突会被拒绝；尚不提供跨进程强制锁或自动文本合并。重要笔记建议避免在两个编辑器中同时持续输入。

## 启动与开发

项目根目录：

```powershell
python -m venv backend/.venv
backend\.venv\Scripts\python -m pip install -r backend/requirements-lock.txt
backend\.venv\Scripts\python -m backend
# 指定保存位置和端口
backend\.venv\Scripts\python -m backend --workspace "D:\ResearchLibraries\课题" --port 8001
```

`requirements-lock.txt` 记录本次 Windows/Python 3.12 验证的完整依赖（含测试工具）。需要更新版本时先调整 `requirements.txt`／`requirements-dev.txt`，验证后重新锁定。

前端修改后在 `frontend` 下运行 `npm ci`、`npm run build`。部署时已有 `dist` 可直接使用，无需 Node.js。当前前端开发依赖的部分包声明 Node.js 24.15+，本机 24.14 已通过此次测试，但新设备建议使用满足依赖要求的版本。

## 接口

先同源访问 `GET /api/session`，获取本地会话令牌与 HttpOnly Cookie，再通过 `/api/auth/register`、`/api/auth/login` 建立账号会话。业务接口必须同时持有有效账号会话；`/api/session` 本身不代表账号已登录。写请求携带 `X-LexiVault-Token`；账号设置和退出还需要 `X-Account-CSRF`。前端业务请求携带 `X-LexiVault-User`，防止旧页面在浏览器切换账号后继续操作。禁止外站 Origin 和跨站点请求，不开启通配 CORS。

`POST /api/workspaces/choose` 选择并打开本地目录，成功后更新当前账号的打开记录和当前空间。多个账号分别选择同一目录时使用同一份资料。`GET /api/workspaces` 按当前账号的打开时间返回目录，空间子接口和事件连接使用该账号的打开记录。更新后需重启后端。

`POST /api/workspaces` 接收名称并打开系统目录选择器。在选定的父目录下创建同名工作空间，成功后自动打开。取消时返回 `{"cancelled":true}`，遇到同名文件或目录时返回 409。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/api/workspaces` | 列表／创建工作空间 |
| POST | `/api/workspaces/choose` | 本机目录选择窗口 |
| GET | `/api/workspaces/{w}/documents` | 当前空间的论文 |
| POST | `/api/workspaces/{w}/imports` | multipart 文件字段 `file`、`directory`；成功返回文献及重复标记 |
| GET | `/api/workspaces/{w}/documents/{d}/file?revision=...` | PDF 原件，支持浏览器范围读取 |
| PUT | `/api/workspaces/{w}/documents/{d}/position` | `{page: 1}` |
| GET / PUT | `/api/workspaces/{w}/documents/{d}/note` | 读取／保存 `{markdown, expected_revision, path?}` |
| POST | `/api/workspaces/{w}/documents/{d}/conflicts` | 保存独立冲突副本 |
| GET | `/api/workspaces/{w}/documents/{d}/history` | 历史版本列表 |
| GET | `/api/workspaces/{w}/documents/{d}/history/{hash}` | 历史正文 |
| WebSocket | `/api/workspaces/{w}/events` | 文件变化通知与心跳 |

arXiv 下载器与本地上传共用 PDF 校验和 `Workspace.ingest`。检索为 `GET /api/discovery/arxiv/search`，单篇获取为 `POST /api/workspaces/{workspace_id}/discovery/arxiv/acquire`，提交来源版本 ID 与已有工作空间相对目录。检索无需 API Key。下载按来源限流，结果会返回 `downloaded`、`already_available`、`metadata_only` 或 `version_available`。新版本经确认后单独保存。

OpenAlex 在 `/api/discovery/openalex/credential` 提供查看绑定状态、验证并保存 Key（`PUT`）、删除绑定（`DELETE`）。检索 `GET /api/discovery/openalex/search` 和单篇获取 `POST /api/workspaces/{workspace_id}/discovery/openalex/acquire` 都从登录账号读取加密保存的 Key。公开 PDF 优先，OpenAlex 缓存作为备用。成功响应的 `download_source` 表示 `public` 或 `cache`。部署用主密钥详见 [数据库说明](DATABASE.md#openalex-个人凭据)。

文件树接口：`GET/POST /api/workspaces/{w}/files`，以及其下 `/move`、`/upload`、`/delete`、`/content?path=`。`POST /trash` 是系统删除的兼容别名；`GET /trash`、`/trash/{id}/restore` 仅用于恢复旧版本的内部回收站内容。所有用户文件操作限制在空间内，禁止内部目录、越界路径和符号链接。关联阅读笔记：`POST /api/workspaces/{w}/files/documents/{d}/note`，正文 `{path}`。

## 测试与边界

```powershell
backend\.venv\Scripts\python -X utf8 -m pytest backend/tests -q
cd frontend
npm ci --prefix qa --ignore-scripts
npm test
python -X utf8 qa/check_static.py
```

首版限制：每份 PDF 最大 50 MiB、1–3000 页；不支持加密 PDF，不做 OCR。扫描 PDF 可显示原图，但没有可摘录的文字层。PDF 检查不代表正文已正确解析或已建立检索索引。笔记正文最大约 2 MiB。

文献来源支持 arXiv 和 OpenAlex。正文索引、PDF 转 Markdown、多人实时协作和跨设备同步仍待接入。研究计划现已改为本地 Markdown 与附件，支持浏览器旧数据迁移、外部修改检测、冲突保护与应急草稿，详见 [研究计划本地文件](PLANS.md)。
