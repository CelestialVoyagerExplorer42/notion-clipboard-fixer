/**
 * Notion Clipboard Title Fixer
 *
 * 扫描 Clipboard 数据库的 Untitled 视图:
 * 凡 AI Title 属性已是有效标题的页面, 将页面标题(Name)替换为 AI Title 的值。
 *
 * 环境变量:
 *   NOTION_API_TOKEN         — Notion Integration Token (须能访问 Clipboard 库)
 *   NOTION_UNTITLED_VIEW_ID  — Untitled 视图 ID
 */

import { Client } from "@notionhq/client";

// ─── Config ────────────────────────────────────────────────────────────────

const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_UNTITLED_VIEW_ID = process.env.NOTION_UNTITLED_VIEW_ID;
const PAGE_SIZE = 100;
const CONCURRENCY = 8; // 并发度: retrieve + update 的并行上限
const MAX_RETRIES = 5; // 429 重试上限

if (!NOTION_API_TOKEN) {
  console.error("❌ Missing NOTION_API_TOKEN");
  process.exit(1);
}
if (!NOTION_UNTITLED_VIEW_ID) {
  console.error("❌ Missing NOTION_UNTITLED_VIEW_ID");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_TOKEN });
const VIEW_ID: string = NOTION_UNTITLED_VIEW_ID;

// ─── Title Helpers ─────────────────────────────────────────────────────────

/** 判断 AI Title 是否是一个「可用的标题」 */
function isUsableTitle(raw: string | undefined | null): boolean {
  const t = (raw ?? "").trim();
  if (!t) return false;
  // Notion AI 未生成出标题时的占位
  if (/^no\s*content$/i.test(t)) return false;
  // 剪藏默认时间戳样式: 2026年4月23日 22:49 / 2026年4月23日 22:49 记录 ...
  if (/^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(t)) return false;
  return true;
}

/** 清理标题里的 markdown 痕迹, 避免标题带语法垃圾 */
function sanitizeTitle(raw: string): string {
  return (
    raw
      // [text](url) -> text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 去掉残留的 ** / __ / * / _ 强调符
      .replace(/[*_]{1,3}/g, "")
      // 折叠空白与换行
      .replace(/\s+/g, " ")
      .trim()
      // 标题上限保护
      .slice(0, 300)
  );
}

// ─── Rate Limit Helpers ────────────────────────────────────────────────────

/** 指数退避重试, 处理 429 Too Many Requests */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status: number }).status
          : undefined;
      if (status === 429 && attempt < MAX_RETRIES) {
        // Notion API 返回的 Retry-After 或默认退避
        const retryAfter =
          typeof err === "object" && err !== null && "headers" in err
            ? (err as { headers?: Record<string, string> }).headers?.[
                "retry-after"
              ]
            : undefined;
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * 2 ** attempt, 30_000); // 最大 30s
        console.warn(
          `⏳ [${label}] 429 rate limit, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`
        );
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[${label}] Exceeded ${MAX_RETRIES} retries`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Concurrency Pool ──────────────────────────────────────────────────────

/**
 * 并发限制执行器: 限制同时运行的 Promise 数量,
 * 避免 750+ 页面全部同时发请求导致 429。
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task()
      .then((result) => {
        results.push(result);
      })
      .catch((err) => {
        results.push(err as T); // 错误会在最后统一处理
      })
      .finally(() => {
        executing.delete(p);
      });

    executing.add(p);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// ─── View Query (fetch-based, SDK 可能尚未内置) ────────────────────────────

interface ViewQueryResult {
  results: Array<{ id: string }>;
  has_more: boolean;
  next_cursor: string | null;
  query_id: string;
}

interface ViewQueryResponse {
  results: Array<{ id: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

/** 创建 View Query (POST /v1/views/{view_id}/queries) */
async function createViewQuery(
  viewId: string
): Promise<ViewQueryResult> {
  return withRetry(async () => {
    const res = await fetch(
      `https://api.notion.com/v1/views/${viewId}/queries`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ page_size: PAGE_SIZE }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`View query create failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ViewQueryResult>;
  }, "createViewQuery");
}

/** 获取下一页 (GET /v1/views/{view_id}/queries/{query_id}/results) */
async function getViewQueryResults(
  viewId: string,
  queryId: string,
  startCursor?: string
): Promise<ViewQueryResponse> {
  const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (startCursor) params.set("start_cursor", startCursor);

  return withRetry(async () => {
    const res = await fetch(
      `https://api.notion.com/v1/views/${viewId}/queries/${queryId}/results?${params}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${NOTION_API_TOKEN}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`View query results failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<ViewQueryResponse>;
  }, "getViewQueryResults");
}

// ─── Summary Type ──────────────────────────────────────────────────────────

interface Summary {
  totalInView: number;
  updated: number;
  skippedNoTitle: number;
  skippedUnusable: number;
  skippedSameName: number;
  errors: number;
  details: Array<{ id: string; from: string; to: string } | { id: string; error: string }>;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const summary: Summary = {
    totalInView: 0,
    updated: 0,
    skippedNoTitle: 0,
    skippedUnusable: 0,
    skippedSameName: 0,
    errors: 0,
    details: [],
  };

  console.log(`🚀 Starting title fix — view: ${VIEW_ID}`);

  // ── Step 1: View Query 分页拉取所有页面 ID ──
  const pageIds: string[] = [];
  let queryId: string | undefined;

  const first = await createViewQuery(VIEW_ID);
  queryId = first.query_id;
  pageIds.push(...first.results.map((p) => p.id));
  console.log(`📄 Page 1: ${first.results.length} pages (total so far: ${pageIds.length})`);

  let cursor = first.next_cursor;
  while (first.has_more && cursor) {
    const next = await getViewQueryResults(
      VIEW_ID,
      queryId,
      cursor
    );
    pageIds.push(...next.results.map((p) => p.id));
    console.log(`📄 Next page: +${next.results.length} (total: ${pageIds.length})`);
    cursor = next.next_cursor;
    if (!next.has_more) break;
  }

  summary.totalInView = pageIds.length;
  console.log(`📊 Total pages in Untitled view: ${pageIds.length}`);

  // ── Step 2: 清理 Query (释放 Notion 端缓存) ──
  if (queryId) {
    try {
      await fetch(
        `https://api.notion.com/v1/views/${VIEW_ID}/queries/${queryId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${NOTION_API_TOKEN}`,
            "Notion-Version": "2022-06-28",
          },
        }
      );
      console.log("🧹 Query cleaned up");
    } catch {
      // DELETE 查询端点可能不存在或无权限, 非致命
      console.log("⚠️  Query cleanup skipped (non-fatal)");
    }
  }

  if (pageIds.length === 0) {
    console.log("✅ No pages in Untitled view — nothing to do.");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // ── Step 3: 并发处理每个页面 ──
  const tasks = pageIds.map((pageId) => async () => {
    try {
      // retrieve
      const page = await withRetry(
        () =>
          notion.pages.retrieve({ page_id: pageId }) as Promise<{
            id: string;
            properties: Record<string, unknown>;
          }>,
        `retrieve:${pageId.slice(0, 8)}`
      );

      const props = page.properties ?? {};

      // 读当前标题(Name)
      const nameProp = props["Name"] as
        | { type: "title"; title: Array<{ plain_text: string }> }
        | undefined;
      const currentName = (nameProp?.title ?? []).map((t) => t.plain_text).join("");

      // 读 AI Title 属性
      const aiProp = props["AI Title"] as
        | { type: "rich_text"; rich_text?: Array<{ plain_text: string }> }
        | undefined;
      const aiRich = aiProp?.rich_text ?? [];
      const aiTitle = aiRich.map((t) => t.plain_text).join("");

      if (!aiTitle.trim()) {
        summary.skippedNoTitle++;
        return { type: "skip" as const, reason: "noTitle" };
      }
      if (!isUsableTitle(aiTitle)) {
        summary.skippedUnusable++;
        return { type: "skip" as const, reason: "unusable" };
      }

      const newName = sanitizeTitle(aiTitle);
      if (!newName || newName === currentName) {
        summary.skippedSameName++;
        return { type: "skip" as const, reason: "sameName" };
      }

      // update
      await withRetry(
        () =>
          notion.pages.update({
            page_id: pageId,
            properties: {
              Name: { title: [{ text: { content: newName } }] },
            },
          }),
        `update:${pageId.slice(0, 8)}`
      );

      summary.updated++;
      summary.details.push({ id: pageId, from: currentName, to: newName });
      return { type: "updated" as const, id: pageId };
    } catch (err) {
      summary.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      summary.details.push({ id: pageId, error: msg });
      return { type: "error" as const, id: pageId, error: msg };
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  // ── Step 4: 输出统计 ──
  console.log("\n═══════════════════════════════════════");
  console.log("📊 Summary");
  console.log("═══════════════════════════════════════");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
