/**
 * Notion Clipboard Title Fixer
 *
 * Scans a saved view in the Clipboard database,
 * finds pages with timestamp/empty titles,
 * and replaces their title with the AI Title property value.
 *
 * View Query API: POST /v1/views/{view_id}/queries
 * Cleanup: DELETE /v1/views/{view_id}/queries/{query_id}
 */

import { Client } from "@notionhq/client"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN
const NOTION_UNTITLED_VIEW_ID = process.env.NOTION_UNTITLED_VIEW_ID
const PAGE_SIZE = 100
const CONCURRENCY = 8

if (!NOTION_API_TOKEN) {
  console.error("❌ NOTION_API_TOKEN is not set")
  process.exit(1)
}
if (!NOTION_UNTITLED_VIEW_ID) {
  console.error("❌ NOTION_UNTITLED_VIEW_ID is not set")
  process.exit(1)
}

const notion = new Client({ auth: NOTION_API_TOKEN })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUsableTitle(raw: string | undefined | null): boolean {
  const t = (raw ?? "").trim()
  if (!t) return false
  if (/^no\s*content$/i.test(t)) return false
  // Timestamp-style default titles: "2026年4月23日 22:49" / "...的链接分享"
  if (/^\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(t)) return false
  return true
}

function sanitizeTitle(raw: string): string {
  return (
    raw
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // [text](url) -> text
      .replace(/[*_]{1,3}/g, "")                  // strip bold/italic markers
      .replace(/\s+/g, " ")                       // collapse whitespace
      .trim()
      .slice(0, 300)                              // truncate to 300 chars
  )
}

/**
 * Exponential backoff retry for 429 / transient errors.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status: number }).status
          : undefined
      if (status === 429 || status === 503 || status === 500) {
        const retryAfter =
          typeof err === "object" && err !== null && "headers" in err
            ? (err as { headers?: Record<string, string> }).headers?.[
                "retry-after"
              ]
            : undefined
        const delay = retryAfter
          ? Number(retryAfter) * 1000
          : Math.min(1000 * 2 ** attempt + Math.random() * 500, 30_000)
        console.warn(
          `⚠️ ${label}: HTTP ${status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`,
        )
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error(`Exhausted retries for ${label}`)
}

// ---------------------------------------------------------------------------
// Concurrency-limited executor
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let idx = 0
  const next = async () => {
    while (idx < items.length) {
      const i = idx++
      await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next())
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Summary {
  totalInView: number
  updated: Array<{ id: string; from: string; to: string }>
  skippedNoTitle: number
  skippedUnusable: number
  skippedSameName: number
  errors: Array<{ id: string; error: string }>
}

async function main(): Promise<void> {
  const summary: Summary = {
    totalInView: 0,
    updated: [],
    skippedNoTitle: 0,
    skippedUnusable: 0,
    skippedSameName: 0,
    errors: [],
  }

  // --- 1. View Query: fetch all page ids in the "Untitled" view ---
  const pageIds: string[] = []

  const first = await withRetry(
    () =>
      notion.views.queries.create({
        view_id: NOTION_UNTITLED_VIEW_ID!,
        page_size: PAGE_SIZE,
      }),
    "views.queries.create",
  )
  pageIds.push(...first.results.map((p) => p.id))
  let cursor = first.next_cursor
  while (first.has_more && cursor) {
    const next = await withRetry(
      () =>
        notion.views.queries.results({
          view_id: NOTION_UNTITLED_VIEW_ID!,
          query_id: first.id,
          start_cursor: cursor!,
          page_size: PAGE_SIZE,
        }),
      "views.queries.results",
    )
    pageIds.push(...next.results.map((p) => p.id))
    cursor = next.next_cursor ?? null
    if (!next.has_more) break
  }
  summary.totalInView = pageIds.length

  // --- 2. Cleanup: delete the query to avoid Notion-side cache bloat ---
  try {
    await withRetry(
      () =>
        notion.views.queries.delete({
          view_id: NOTION_UNTITLED_VIEW_ID!,
          query_id: first.id,
        }),
      "views.queries.delete",
    )
  } catch {
    // Best-effort; log but don't fail the run
    console.warn("⚠️ Could not clean up view query (non-fatal)")
  }

  console.log(`🔍 Found ${pageIds.length} pages in Untitled view`)

  // --- 3. Process each page (with concurrency limit) ---
  await runWithConcurrency(pageIds, CONCURRENCY, async (pageId) => {
    try {
      // Retrieve page properties
      const page = await withRetry(
        () => notion.pages.retrieve({ page_id: pageId }),
        `pages.retrieve(${pageId.slice(0, 8)})`,
      )
      const props = (page as { properties?: Record<string, unknown> }).properties ?? {}

      // Read current title (Name)
      const nameProp = props["Name"] as
        | { type: "title"; title: Array<{ plain_text: string }> }
        | undefined
      const currentName = (nameProp?.title ?? []).map((t) => t.plain_text).join("")

      // Read AI Title property
      const aiProp = props["AI Title"] as
        | { type: "rich_text"; rich_text?: Array<{ plain_text: string }> }
        | undefined
      const aiTitle = (aiProp?.rich_text ?? []).map((t) => t.plain_text).join("")

      // Skip: no AI Title at all
      if (!aiTitle.trim()) {
        summary.skippedNoTitle++
        return
      }

      // Skip: AI Title is unusable
      if (!isUsableTitle(aiTitle)) {
        summary.skippedUnusable++
        return
      }

      const newName = sanitizeTitle(aiTitle)

      // Skip: nothing to change
      if (!newName || newName === currentName) {
        summary.skippedSameName++
        return
      }

      // Update page title
      await withRetry(
        () =>
          notion.pages.update({
            page_id: pageId,
            properties: {
              Name: { title: [{ text: { content: newName } }] },
            },
          }),
        `pages.update(${pageId.slice(0, 8)})`,
      )

      summary.updated.push({ id: pageId, from: currentName, to: newName })
      console.log(`  ✅ ${currentName} → ${newName}`)
    } catch (err) {
      summary.errors.push({
        id: pageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // --- 4. Output summary ---
  console.log("\n📊 Summary:")
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error("❌ Fatal error:", err)
  process.exit(1)
})
