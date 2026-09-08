# Notion Clipboard Title Fixer

将 📋 Clipboard 数据库 **Untitled 视图**中时间戳/空标题的页面,替换为 `AI Title` 属性的值。

## 工作原理

```
GitHub Actions (每小时 :17/:47 定时触发)
   │
   ▼
fix-titles.ts (Node.js 脚本)
   │  1. View Query API 获取 Untitled 视图所有页面
   │  2. 逐页读取 AI Title 属性
   │  3. 判断是否为有效标题
   │  4. 有效则 PATCH Name 属性
   ▼
📋 Clipboard 数据库 (标题已更新,页面自动移出 Untitled 视图)
```

## 关键特性

| 特性 | 说明 |
|---|---|
| **定时调度** | 每小时 :17 和 :47 触发(避开整点高峰) |
| **并发控制** | 8 路并发 + 429 指数退避重试 |
| **幂等安全** | 标题替换后页面自动移出 Untitled 视图,不会重复处理 |
| **View Query 清理** | 执行后自动删除 query,避免 Notion 缓存膨胀 |
| **保活机制** | 50 天无活动自动提交续期,防止 GitHub Actions 暂停 |
| **无外部依赖** | 纯脚本调用 Notion API,不需要 Worker/Server |

## AI Title 判定规则

以下情况**跳过**(不替换):

| 类型 | 示例 |
|---|---|
| 空标题 | `""` |
| Notion AI 占位 | `No content` |
| 剪藏时间戳 | `2026年4月23日 22:49` |
| 带后缀时间戳 | `2026年9月6日 05:07 的链接分享` |

其他值视为有效标题,清洗后写入页面 Name。

## 文件结构

```
notion-clipboard-fixer/
├── src/
│   └── fix-titles.ts       # 核心清洗脚本
├── .github/
│   └── workflows/
│       └── fix-titles.yml  # GitHub Actions 定时任务
├── package.json
└── tsconfig.json
```

## 配置

### GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 中设置:

| Secret | 说明 | 获取方式 |
|---|---|---|
| `NOTION_API_TOKEN` | Notion Integration Token | https://www.notion.so/my-integrations → 你的 integration → Secret |
| `NOTION_UNTITLED_VIEW_ID` | Untitled 视图 ID | 打开 Clipboard 的 Untitled 视图 → URL 中 `?v=` 后面的值 |

### 仓库权限

Settings → Actions → General → Workflow permissions → 选择 **Read and write permissions**

(让 keepalive-workflow 能自动提交)

## 手动触发

在 GitHub 仓库页面 → Actions → fix-titles → Run workflow

## 本地运行

```bash
npm install
NOTION_API_TOKEN=ntn_xxx NOTION_UNTITLED_VIEW_ID=3c1752a1-xxx npm run fix-titles
```

## 故障排查

| 问题 | 排查方式 |
|---|---|
| 触发了但没执行 | Actions 页面查看 run 日志,确认 secrets 已设置 |
| 429 Too Many Requests | 脚本内置指数退避重试,3 次后仍失败会报错 |
| View Query 清理失败 | 非致命错误,不影响主逻辑,下次运行会重建 |
| 页面未更新 | 检查 AI Title 属性是否为空/No content/时间戳格式 |

## 定时调度调整

编辑 `.github/workflows/fix-titles.yml`:

```yaml
schedule:
  - cron: "17,47 * * * *"   # 当前:每小时两次
  # - cron: "0 */2 * * *"   # 示例:每 2 小时一次
  # - cron: "0 9 * * *"     # 示例:每天 9 点一次
```

注意:修改后推送到 main/master 分支才生效。
