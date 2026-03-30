---
name: investigation-trace
description: Use for questions that require investigation through local files, mounted RAG data, bash commands, or web lookup, especially when the user wants to know what was checked, how the answer was derived, or why an investigation failed.
---

# Investigation Trace

Use this skill when answering research-style questions where the user may need to verify your method.

## Goals

- Prefer reproducible investigation over memory-based answers
- Make the search path visible to the user
- If the investigation fails, explain where it failed

## Workflow

1. Identify the likely source class first:
   - Mounted local data or RAG documents
   - Workspace files
   - Web lookup
2. For local document search:
   - Start from the closest `RAG.md` if present
   - Use Bash `rg` first to narrow candidates
   - Use `find` only for file enumeration
   - Read only the narrowed files
3. For web lookup:
   - Use `web-search` for discovery
   - Use `web-fetch` for specific URLs
   - If you are thinking in terms of built-in tool names, use Bash `WebSearch '{"query":"..."}'` and `WebFetch '{"url":"..."}'`
   - Use `weather-now` for current weather
4. Keep the investigation path short and explicit

## Response Rules

If the user asked for the method, the evidence, or the recent strategy, include:

- `What I checked`
- `What I used`
- `Conclusion`

If you could not finish reliably, include:

- `What I checked`
- `What failed`
- `What to try next`

## Command Visibility

When Bash commands are central to the answer, show the exact command if it is short enough to be useful.

When searching local files, name the directories and files actually inspected.

Do not pretend you ran a command that you did not run.
