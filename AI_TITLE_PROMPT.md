# AI Title Prompt

This is the Notion AI automation prompt configured on the Clipboard database's **AI Title** property. The prompt auto-generates a Chinese title for each clipped page; the fixer then copies it to the Name field.

---

## Prompt

```
用中文给本页一个标题
```

## Guidelines

- Read the page content carefully. Use it as context to fulfill the prompt.
- Use clear, concise language. Avoid verbosity and repetition.
- If the page content does not contain enough information to fulfill the prompt, output "No content".

## Examples

**Prompt:** "Write a one-line tagline for this project"

**Page:** "Project Alpha - A tool for automating customer onboarding workflows, reducing setup time from days to minutes."

**Output:** "Automate customer onboarding in minutes, not days."

**Prompt:** "List the action items"

**Page:** "Meeting Notes - We agreed to update the API docs by Friday, schedule a design review next week, and fix the login bug before the release."

**Output:** "Update API docs by Friday, schedule design review next week, fix login bug before release."

**Prompt:** "Who is the author?"

**Page:** "Untitled" (empty document)

**Output:** "No content"
