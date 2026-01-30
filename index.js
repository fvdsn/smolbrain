#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const { program } = require("commander");
const Database = require("better-sqlite3");

const DB_PATH = path.join(os.homedir(), ".local", "smolbrain.sqlite");

function getDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      content TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    )
  `);
  return db;
}

function store(text, tags) {
  const db = getDb();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO memories (content) VALUES (?)")
    .run(text);
  if (tags && tags.length > 0) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );
    for (const tag of tags) {
      insert.run(lastInsertRowid, tag);
    }
  }
  const row = db
    .prepare("SELECT id, timestamp, content FROM memories WHERE id = ?")
    .get(lastInsertRowid);
  const allTags = getTagsForMemory(db, lastInsertRowid);
  db.close();
  return { row, tags: allTags };
}

function getTagsForMemory(db, memoryId) {
  return db
    .prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag")
    .all(memoryId)
    .map((r) => r.tag);
}

function setTaskStatus(id, newTag) {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM memories WHERE id = ?")
    .get(id);
  if (!row) {
    db.close();
    console.log(`No memory found with id ${id}.`);
    return;
  }
  const tags = getTagsForMemory(db, id);
  if (!tags.includes("task")) {
    db.close();
    console.log(`Memory ${id} is not a task.`);
    return;
  }
  db.prepare(
    "DELETE FROM memory_tags WHERE memory_id = ? AND tag IN ('todo', 'wip', 'done')"
  ).run(id);
  db.prepare(
    "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
  ).run(id, newTag);
  db.close();
  console.log(`Task ${id} is now [${newTag}]`);
}

function printMemory(row, tags) {
  const tagSuffix = tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  console.log(`[${row.id}] [${row.timestamp}]${tagSuffix}\n${row.content}`);
}

function printMemoryPreview(row, tags) {
  const tagSuffix = tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  const lines = row.content.split("\n");
  const preview = lines.slice(0, 3).join("\n");
  const ellipsis = lines.length > 3 ? "\n..." : "";
  console.log(`[${row.id}] [${row.timestamp}]${tagSuffix}\n${preview}${ellipsis}`);
}

function list({ from, to, tags, limit, tail } = {}) {
  const db = getDb();
  const params = [];
  const joins = [];
  const wheres = ["1=1"];

  if (tags && tags.length > 0) {
    joins.push("JOIN memory_tags mt ON m.id = mt.memory_id");
    wheres.push(`mt.tag IN (${tags.map(() => "?").join(", ")})`);
    params.push(...tags);
  }
  if (from) {
    wheres.push("m.timestamp >= ?");
    params.push(from);
  }
  if (to) {
    wheres.push("m.timestamp <= ?");
    params.push(to);
  }

  const order = tail ? "DESC" : "ASC";
  const limitClause = limit || tail ? "LIMIT ?" : "";
  if (limit) params.push(limit);
  if (tail) params.push(tail);

  const sql = `SELECT DISTINCT m.id, m.timestamp, m.content FROM memories m
    ${joins.join(" ")}
    WHERE ${wheres.join(" AND ")}
    ORDER BY m.timestamp ${order}
    ${limitClause}`;

  let rows = db.prepare(sql).all(...params);
  if (tail) rows.reverse();

  for (const row of rows) {
    const memoryTags = getTagsForMemory(db, row.id);
    printMemory(row, memoryTags);
  }
  db.close();
}

function rememberById(id) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, timestamp, content FROM memories WHERE id = ?")
    .get(id);

  if (!row) {
    db.close();
    console.log(`No memory found with id ${id}.`);
    return;
  }
  const tags = getTagsForMemory(db, row.id);
  db.close();
  printMemory(row, tags);
}

function search(text, { from, to, tags, limit, tail } = {}) {
  const db = getDb();
  const params = [];
  const joins = [];
  const wheres = ["m.content LIKE ?"];
  params.push(`%${text}%`);

  if (tags && tags.length > 0) {
    joins.push("JOIN memory_tags mt ON m.id = mt.memory_id");
    wheres.push(`mt.tag IN (${tags.map(() => "?").join(", ")})`);
    params.push(...tags);
  }
  if (from) {
    wheres.push("m.timestamp >= ?");
    params.push(from);
  }
  if (to) {
    wheres.push("m.timestamp <= ?");
    params.push(to);
  }

  const order = tail ? "DESC" : "ASC";
  const limitClause = limit || tail ? "LIMIT ?" : "";
  if (limit) params.push(limit);
  if (tail) params.push(tail);

  const sql = `SELECT DISTINCT m.id, m.timestamp, m.content FROM memories m
    ${joins.join(" ")}
    WHERE ${wheres.join(" AND ")}
    ORDER BY m.timestamp ${order}
    ${limitClause}`;

  let rows = db.prepare(sql).all(...params);
  if (tail) rows.reverse();

  const needle = text.toLowerCase();

  for (const row of rows) {
    const lines = row.content.split("\n");
    const matchIndices = new Set();

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) {
          matchIndices.add(j);
        }
      }
    }

    const sorted = [...matchIndices].sort((a, b) => a - b);
    const parts = [];
    let group = [];

    for (const idx of sorted) {
      if (group.length > 0 && idx !== group[group.length - 1] + 1) {
        parts.push(group.map((i) => lines[i]).join("\n"));
        group = [];
      }
      group.push(idx);
    }
    if (group.length > 0) {
      parts.push(group.map((i) => lines[i]).join("\n"));
    }

    const memoryTags = getTagsForMemory(db, row.id);
    const tagSuffix = memoryTags.length > 0 ? ` [${memoryTags.join(", ")}]` : "";
    console.log(`[${row.id}] [${row.timestamp}]${tagSuffix}`);
    const prefix = sorted[0] > 0 ? "...\n" : "";
    const suffix = sorted[sorted.length - 1] < lines.length - 1 ? "\n..." : "";
    console.log(prefix + parts.join("\n...\n") + suffix);
  }
  db.close();
}

program.name("smolbrain").description("Long-term memory for AI agents");

program
  .command("store [text...]")
  .description("Store a memory (pass text as args or pipe via stdin)")
  .option("-t, --tag <tag>", "Tag(s) to attach to the memory (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .action((textParts, options) => {
    function storeAndPrint(text) {
      const { row, tags } = store(text, options.tag.length > 0 ? options.tag : undefined);
      printMemoryPreview(row, tags);
    }
    if (textParts.length > 0) {
      storeAndPrint(textParts.join(" "));
    } else {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => {
        const text = data.trim();
        if (!text) {
          console.error("No input provided.");
          process.exit(1);
        }
        storeAndPrint(text);
      });
    }
  });

program
  .command("list")
  .description("List memories, optionally filtered by date range, tags, limit")
  .option("-t, --tag <tag>", "Filter by tag(s) (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .option("--from <date>", "Start date (inclusive)")
  .option("--to <date>", "End date (inclusive)")
  .option("--limit <n>", "Show first N results (oldest first)", Number)
  .option("--tail <n>", "Show last N results (chronological order)", Number)
  .action((options) => {
    if (options.limit && options.tail) {
      console.error("Error: --limit and --tail are mutually exclusive.");
      process.exit(1);
    }
    list({
      from: options.from,
      to: options.to,
      tags: options.tag.length > 0 ? options.tag : undefined,
      limit: options.limit,
      tail: options.tail,
    });
  });

program
  .command("get <id>")
  .description("Retrieve a single memory by its ID")
  .action((id) => {
    rememberById(Number(id));
  });

program
  .command("search <text>")
  .description("Search memories by content (case insensitive)")
  .option("-t, --tag <tag>", "Filter by tag(s) (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .option("--from <date>", "Start date (inclusive)")
  .option("--to <date>", "End date (inclusive)")
  .option("--limit <n>", "Show first N results (oldest first)", Number)
  .option("--tail <n>", "Show last N results (chronological order)", Number)
  .action((text, options) => {
    if (options.limit && options.tail) {
      console.error("Error: --limit and --tail are mutually exclusive.");
      process.exit(1);
    }
    search(text, {
      from: options.from,
      to: options.to,
      tags: options.tag.length > 0 ? options.tag : undefined,
      limit: options.limit,
      tail: options.tail,
    });
  });

program
  .command("store-task [text...]")
  .description("Store a task (automatically tagged with 'task' and 'todo')")
  .option("-t, --tag <tag>", "Additional tag(s) (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .action((textParts, options) => {
    const tags = ["task", "todo", ...options.tag];
    function storeAndPrint(text) {
      const { row, tags: allTags } = store(text, tags);
      printMemoryPreview(row, allTags);
    }
    if (textParts.length > 0) {
      storeAndPrint(textParts.join(" "));
    } else {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => {
        const text = data.trim();
        if (!text) {
          console.error("No input provided.");
          process.exit(1);
        }
        storeAndPrint(text);
      });
    }
  });

program
  .command("list-tasks [status]")
  .description("List tasks (default: todo and wip). Status: todo, wip, done")
  .option("-t, --tag <tag>", "Additional tag(s) to filter by (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .option("--from <date>", "Start date (inclusive)")
  .option("--to <date>", "End date (inclusive)")
  .option("--limit <n>", "Show first N results (oldest first)", Number)
  .option("--tail <n>", "Show last N results (chronological order)", Number)
  .action((status, options) => {
    if (options.limit && options.tail) {
      console.error("Error: --limit and --tail are mutually exclusive.");
      process.exit(1);
    }
    const validStatuses = ["todo", "wip", "done"];
    const statuses = status
      ? [status]
      : ["todo", "wip"];
    if (status && !validStatuses.includes(status)) {
      console.error(`Invalid status "${status}". Use: ${validStatuses.join(", ")}`);
      process.exit(1);
    }
    const db = getDb();
    const params = [];
    const joins = ["JOIN memory_tags mt1 ON m.id = mt1.memory_id"];
    const wheres = [`mt1.tag IN (${statuses.map(() => "?").join(", ")})`];
    params.push(...statuses);

    if (options.tag.length > 0) {
      joins.push("JOIN memory_tags mt2 ON m.id = mt2.memory_id");
      wheres.push(`mt2.tag IN (${options.tag.map(() => "?").join(", ")})`);
      params.push(...options.tag);
    }
    if (options.from) {
      wheres.push("m.timestamp >= ?");
      params.push(options.from);
    }
    if (options.to) {
      wheres.push("m.timestamp <= ?");
      params.push(options.to);
    }

    const order = options.tail ? "DESC" : "ASC";
    const limitClause = options.limit || options.tail ? "LIMIT ?" : "";
    if (options.limit) params.push(options.limit);
    if (options.tail) params.push(options.tail);

    const sql = `SELECT DISTINCT m.id, m.timestamp, m.content FROM memories m
      ${joins.join(" ")}
      WHERE ${wheres.join(" AND ")}
      ORDER BY m.timestamp ${order}
      ${limitClause}`;

    let rows = db.prepare(sql).all(...params);
    if (options.tail) rows.reverse();

    for (const row of rows) {
      const memoryTags = getTagsForMemory(db, row.id);
      printMemory(row, memoryTags);
    }
    db.close();
  });

program
  .command("mark-task <id> <status>")
  .description("Set task status: todo, wip, or done")
  .action((id, status) => {
    const validStatuses = ["todo", "wip", "done"];
    if (!validStatuses.includes(status)) {
      console.error(`Invalid status "${status}". Use: ${validStatuses.join(", ")}`);
      process.exit(1);
    }
    setTaskStatus(Number(id), status);
  });

program.parse();
