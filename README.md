# Notion Clipboard Title Fixer

自动将 Notion Clipboard 数据库中「Name 为空/Untitled」的页面,用其 **AI Title** 属性值补全标题。

通过 GitHub Actions 定时运行（每小时 2 次）,无需部署服务器。

---

## 工作原理

1. 查询 Clipboard 数据库的 **Untitled 视图**（筛选 Name 为空的条目）
2. 读取每个页面的 **AI Title**（rich_text 属性）
3. 过滤掉无效标题（空白、`No content` 占位符、时间戳格式）
4. 清理 markdown 痕迹（`[text](url)` → `text`、去掉 `*_*` 等）
5. 将清理后的标题写入页面的 **Name** 属性

支持并发（默认 8）和 429 限流自动重试（指数退避,最大 30s）。

---

## 部署

### 1. Fork / Clone 本仓库

### 2. 在 Notion 创建 Integration

- 打开 [Notion Integrations](https://www.notion.so/my-integrations)
- 创建一个新的 Internal Integration,获取 API Token
- 在 Clipboard 数据库页面 → ⋯ → Connections → 添加该 Integration

### 3. 获取 Untitled 视图 ID

- 打开 Clipboard 数据库的 **Untitled** 视图
- URL 格式: `https://notion.so/xxx?v=<VIEW_ID>`
- 复制 `v=` 后面的 UUID

### 4. 配置 GitHub Secrets

进入仓库 Settings → Secrets and variables → Actions,添加:

| Secret 名称 | 说明 |
|---|---|
| `NOTION_API_TOKEN` | Notion Integration Token（`ntn_` 开头） |
| `NOTION_UNTITLED_VIEW_ID` | Untitled 视图 ID（UUID 格式） |

### 5. 启用 Actions

进入 Actions 页面,点击 **I understand my workflows, go ahead and enable them**。

定时任务将自动运行:每小时的第 17 和 47 分钟。

---

## 本地运行

```bash
# 安装依赖
npm ci

# 设置环境变量
export NOTION_API_TOKEN=ntn_xxxx
export NOTION_UNTITLED_VIEW_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# 执行
npm run fix-titles
```

---

## 配置项

| 常量 | 默认值 | 说明 |
|---|---|---|
| `PAGE_SIZE` | 100 | 每页拉取条目数（Notion API 上限） |
| `CONCURRENCY` | 8 | 并发请求数 |
| `MAX_RETRIES` | 5 | 429 限流最大重试次数 |

如需调整,修改 `src/fix-titles.ts` 顶部常量即可。

---

## 标题过滤规则

以下情况的 AI Title **不会**用来替换 Name:

- 空白 / 无内容
- `No content`（Notion AI 未生成内容时的占位）
- 时间戳格式（如 `2026年4月23日 22:49`——剪藏默认标题）

清理后的标题最长 300 字符。

---

## License

MIT
