# smolbrain

Long-term memory for AI agents. A local-first CLI tool backed by SQLite with full-text search.

## Install

```bash
npm install -g smolbrain
```

Data is stored in `~/.local/smolbrain.sqlite`.

## Usage

### Memories

```bash
# Store a memory
smolbrain add "the deploy key is in 1password"
smolbrain add -t ops "rotate credentials quarterly"
echo "multi-line content" | smolbrain add

# List memories
smolbrain ls
smolbrain ls --tail 5
smolbrain ls -t ops
smolbrain ls --from 2025-01-01 --to 2025-12-31

# Get a specific memory
smolbrain get 42

# Full-text search (FTS5)
smolbrain find "credentials"
smolbrain find "deploy key" -t ops

# Edit (archives the original, creates a new memory)
smolbrain edit 42 "the deploy key is in vault, not 1password"

# Tag management
smolbrain tag 42 important
smolbrain untag 42 ops

# Soft-delete and restore
smolbrain rm 42
smolbrain restore 42
smolbrain ls -a  # include archived
```

### Tasks

```bash
# Store a task (auto-tagged with 'task' and 'todo')
smolbrain task "migrate database to v3"

# List tasks (default: todo and wip)
smolbrain tasks
smolbrain tasks done

# Update task status
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

### Output

All listing commands support `--json` for structured output:

```bash
smolbrain ls --json
smolbrain find "deploy" --json
smolbrain get 42 --json
```

## Commands

| Command | Description |
|---|---|
| `add [text...]` | Store a memory (args or stdin) |
| `ls` | List memories |
| `get <id>` | Retrieve a memory by ID |
| `find <text>` | Full-text search |
| `edit <id> [text...]` | Replace content (archives original) |
| `tag <id> <tag>` | Add a tag |
| `untag <id> <tag>` | Remove a tag |
| `rm <id>` | Soft-delete (archive) |
| `restore <id>` | Restore archived memory |
| `task [text...]` | Store a task |
| `tasks [status]` | List tasks |
| `mark <id> <status>` | Set task status (todo/wip/done) |

## Claude Code skill

A `SKILL.md` is included so Claude Code can use smolbrain automatically. Copy it to your skills directory:

```bash
mkdir -p ~/.claude/skills/smolbrain
cp $(npm root -g)/smolbrain/SKILL.md ~/.claude/skills/smolbrain/SKILL.md
```

Claude will then use smolbrain to store and recall information across sessions.

## Design

- **SQLite + FTS5** for storage and search. No external services.
- **Soft-delete** by default. `rm` archives, `restore` brings it back. Nothing is lost.
- **Edit creates a new version** and archives the original. History is preserved.
- **Tags** for flexible organization. Tasks are just memories with `task` + status tags.
- **Single file** at `~/.local/smolbrain.sqlite`. Easy to back up, move, or inspect.

## License

ISC
