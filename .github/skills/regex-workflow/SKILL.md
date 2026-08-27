---
name: regex-workflow
description: "Use when searching workspace files with a regular expression, locating code patterns, or extracting text matches."
---

# Regex Search Workflow

Use the `regexSearch` tool for regular-expression searches across workspace files.

## Procedure

1. Choose a specific file glob before searching.
2. Call `regexSearch` with `pattern` and `glob`; add `flags` such as `i` when needed.
3. Review the returned file names, line numbers, and matching text.
4. Use the matching context to decide whether an edit is needed.

Do not use a shell search command for regex searches when `regexSearch` is available.