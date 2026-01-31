---
name: smolbrain
description: Long-term memory store. Use to remember information across sessions, search past memories, and manage tasks. Use when you need to save something for later, recall previous context, or track work items.
allowed-tools: Bash(smolbrain *)
---

# smolbrain - Long-term memory

A local SQLite-backed memory store with full-text search. Use it to persist information across sessions.

## When to use

- **Store**: when you learn something worth remembering (decisions, preferences, project context, debugging findings)
- **Search**: when you need to recall prior context before starting work
- **Tasks**: when tracking work items across sessions

## Commands

### Store and retrieve

```bash
# Store a memory (use tags to organize)
smolbrain add "the auth service uses JWT with RS256"
smolbrain add -t project-x "deploy requires VPN access"

# Pipe longer content
echo "detailed notes here" | smolbrain add -t meeting

# Full-text search
smolbrain find "auth"
smolbrain find "deploy" -t project-x

# List recent memories
smolbrain ls --tail 10

# Get a specific memory
smolbrain get 42
```

### Edit and organize

```bash
# Edit (archives original, creates new memory with same tags)
smolbrain edit 42 "corrected information"

# Tag management
smolbrain tag 42 important
smolbrain untag 42 outdated

# Soft-delete and restore
smolbrain rm 42
smolbrain restore 42
```

### Tasks

```bash
# Create a task
smolbrain task "migrate database to v3"

# List tasks (default: todo + wip)
smolbrain tasks
smolbrain tasks done

# Update status
smolbrain mark 7 wip
smolbrain mark 7 done
```

### Pagination

```bash
smolbrain ls --limit 10            # first 10 results
smolbrain ls --limit 10 --offset 5 # skip 5, then show 10
smolbrain ls --tail 10             # last 10 results
```

`--limit`, `--tail`, `--offset`, `--from`, and `--to` work on `ls`, `find`, and `tasks`.

### Structured output

All listing commands support `--json` for structured output:

```bash
smolbrain find "auth" --json
smolbrain ls --tail 5 --json
```

## Guidelines

- Search before storing to avoid duplicates
- Use tags consistently to group related memories
- Prefer short, factual memories over long narratives
- Use `--json` when you need to process the output programmatically
- Archived memories are hidden by default; use `-a` to include them
