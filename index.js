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
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content=memories, content_rowid=id);

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  try {
    db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
  } catch (_) {
    // column already exists
  }
  const ftsCount = db.prepare("SELECT COUNT(*) as n FROM memories_fts").get().n;
  const memCount = db.prepare("SELECT COUNT(*) as n FROM memories").get().n;
  if (ftsCount !== memCount) {
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
  }
  return db;
}

let _pipeline = null;

async function getEmbedder() {
  if (!_pipeline) {
    const { pipeline } = await import("@huggingface/transformers");
    _pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" });
  }
  return _pipeline;
}

async function embed(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Buffer.from(output.data.buffer);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are pre-normalized, so dot product = cosine similarity
}

async function store(text, tags) {
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
  const buf = await embed(text);
  db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(buf, lastInsertRowid);
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

const VALID_STATUSES = ["todo", "wip", "done"];

function formatTagSuffix(tags) {
  return tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
}

function withMemory(id, fn) {
  const db = getDb();
  const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(Number(id));
  if (!row) {
    db.close();
    console.log(`No memory found with id ${id}.`);
    return;
  }
  fn(db, row);
}

function formatMemory(db, row) {
  return { id: row.id, timestamp: row.timestamp, content: row.content, tags: getTagsForMemory(db, row.id) };
}

function printMemory(row, tags) {
  console.log(`[${row.id}] [${row.timestamp}]${formatTagSuffix(tags)}\n${row.content}\n`);
}

function printMemoryPreview(row, tags) {
  const tagSuffix = formatTagSuffix(tags);
  const lines = row.content.split("\n");
  const preview = lines.slice(0, 3).join("\n");
  const ellipsis = lines.length > 3 ? "\n[...]" : "";
  console.log(`[${row.id}] [${row.timestamp}]${tagSuffix}\n${preview}${ellipsis}\n`);
}

function queryMemories(db, { joins = [], wheres = ["1=1"], params = [], limit, offset, tail } = {}) {
  const order = tail ? "DESC" : "ASC";
  const clauses = [];
  const allParams = [...params];

  if (limit || tail) {
    clauses.push("LIMIT ?");
    allParams.push(limit || tail);
  }
  if (offset) {
    clauses.push("OFFSET ?");
    allParams.push(offset);
  }

  const countSql = `SELECT COUNT(DISTINCT m.id) as total FROM memories m
    ${joins.join(" ")}
    WHERE ${wheres.join(" AND ")}`;
  const total = db.prepare(countSql).get(...params).total;

  const sql = `SELECT DISTINCT m.id, m.timestamp, m.content FROM memories m
    ${joins.join(" ")}
    WHERE ${wheres.join(" AND ")}
    ORDER BY m.timestamp ${order}
    ${clauses.join(" ")}`;

  let rows = db.prepare(sql).all(...allParams);
  if (tail) rows.reverse();
  return { rows, total };
}

function printPagination(shown, total, offset) {
  const remaining = total - (offset || 0) - shown;
  if (remaining > 0) {
    console.log(`(${remaining} more result${remaining === 1 ? "" : "s"} available)`);
  }
}

function applyFilters(query, { from, to, tags, all, tagAlias = "mt" } = {}) {
  if (tags && tags.length > 0) {
    query.joins.push(`JOIN memory_tags ${tagAlias} ON m.id = ${tagAlias}.memory_id`);
    query.wheres.push(`${tagAlias}.tag IN (${tags.map(() => "?").join(", ")})`);
    query.params.push(...tags);
  }
  if (!all) {
    query.wheres.push("m.id NOT IN (SELECT memory_id FROM memory_tags WHERE tag = 'archived')");
  }
  if (from) {
    query.wheres.push("m.timestamp >= ?");
    query.params.push(from);
  }
  if (to) {
    query.wheres.push("m.timestamp <= ?");
    query.params.push(to);
  }
}

function list({ from, to, tags, all, limit, tail, offset, json } = {}) {
  const db = getDb();
  const query = { joins: [], wheres: ["1=1"], params: [] };
  applyFilters(query, { from, to, tags, all });
  if (!limit && !tail) limit = 20;

  const { rows, total } = queryMemories(db, { ...query, limit, tail, offset });

  if (json) {
    console.log(JSON.stringify(rows.map((row) => formatMemory(db, row))));
  } else {
    for (const row of rows) {
      const memoryTags = getTagsForMemory(db, row.id);
      printMemory(row, memoryTags);
    }
    printPagination(rows.length, total, offset);
  }
  db.close();
}

function getById(id, { json } = {}) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, timestamp, content FROM memories WHERE id = ?")
    .get(id);

  if (!row) {
    db.close();
    console.log(`No memory found with id ${id}.`);
    return;
  }
  if (json) {
    console.log(JSON.stringify(formatMemory(db, row)));
  } else {
    const tags = getTagsForMemory(db, row.id);
    printMemory(row, tags);
  }
  db.close();
}

function search(text, { from, to, tags, all, limit, tail, offset, json } = {}) {
  const db = getDb();
  const ftsQuery = text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
  const query = { joins: ["JOIN memories_fts ON m.id = memories_fts.rowid"], wheres: ["memories_fts MATCH ?"], params: [ftsQuery] };
  applyFilters(query, { from, to, tags, all });
  if (!limit && !tail) limit = 20;

  const { rows, total } = queryMemories(db, { ...query, limit, tail, offset });

  if (json) {
    console.log(JSON.stringify(rows.map((row) => formatMemory(db, row))));
    db.close();
    return;
  }

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
    console.log(`[${row.id}] [${row.timestamp}]${formatTagSuffix(memoryTags)}`);
    const prefix = sorted[0] > 0 ? "[...]\n" : "";
    const suffix = sorted[sorted.length - 1] < lines.length - 1 ? "\n[...]\n" : "\n";
    console.log(prefix + parts.join("\n[...]\n") + suffix);
  }
  printPagination(rows.length, total, offset);
  db.close();
}

function readInput(textParts, callback) {
  if (textParts.length > 0) {
    return callback(textParts.join(" "));
  }
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", async () => {
    const text = data.trim();
    if (!text) {
      console.error("No input provided.");
      process.exit(1);
    }
    await callback(text);
  });
}

function addFilterOptions(cmd) {
  return cmd
    .option("-t, --tag <tag>", "Filter by tag(s) (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
    .option("--from <date>", "Start date (inclusive)")
    .option("--to <date>", "End date (inclusive)")
    .option("--limit <n>", "Show first N results (oldest first)", Number)
    .option("--tail <n>", "Show last N results (chronological order)", Number)
    .option("--offset <n>", "Skip first N results", Number)
    .option("-a, --all", "Include archived memories")
    .option("--json", "Output as JSON");
}

function parseFilterOptions(options) {
  if (options.limit && options.tail) {
    console.error("Error: --limit and --tail are mutually exclusive.");
    process.exit(1);
  }
  return {
    from: options.from,
    to: options.to,
    tags: options.tag.length > 0 ? options.tag : undefined,
    all: options.all,
    limit: options.limit,
    tail: options.tail,
    offset: options.offset,
    json: options.json,
  };
}

program.name("smolbrain").description("Long-term memory for AI agents");

program
  .command("add [text...]")
  .description("Store a memory (pass text as args or pipe via stdin)")
  .option("-t, --tag <tag>", "Tag(s) to attach to the memory (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .option("--json", "Output as JSON")
  .action(async (textParts, options) => {
    readInput(textParts, async (text) => {
      const { row, tags } = await store(text, options.tag.length > 0 ? options.tag : undefined);
      if (options.json) {
        console.log(JSON.stringify({ id: row.id, timestamp: row.timestamp, content: row.content, tags }));
      } else {
        printMemoryPreview(row, tags);
      }
    });
  });

addFilterOptions(
  program
    .command("ls")
    .description("List memories, optionally filtered by date range, tags, limit")
).action((options) => {
    list(parseFilterOptions(options));
  });

program
  .command("get <id>")
  .description("Retrieve a single memory by its ID")
  .option("--json", "Output as JSON")
  .action((id, options) => {
    getById(Number(id), { json: options.json });
  });

addFilterOptions(
  program
    .command("find <text>")
    .description("Search memories by content")
).action((text, options) => {
    search(text, parseFilterOptions(options));
  });

program
  .command("task [text...]")
  .description("Store a task (automatically tagged with 'task' and 'todo')")
  .option("-t, --tag <tag>", "Additional tag(s) (repeatable)", (val, acc) => { acc.push(val); return acc; }, [])
  .option("--json", "Output as JSON")
  .action(async (textParts, options) => {
    const tags = ["task", "todo", ...options.tag];
    readInput(textParts, async (text) => {
      const { row, tags: allTags } = await store(text, tags);
      if (options.json) {
        console.log(JSON.stringify({ id: row.id, timestamp: row.timestamp, content: row.content, tags: allTags }));
      } else {
        printMemoryPreview(row, allTags);
      }
    });
  });

addFilterOptions(
  program
    .command("tasks [status]")
    .description("List tasks (default: todo and wip). Status: todo, wip, done")
).action((status, options) => {
    const { tags, from, to, all, limit, tail, offset, json } = parseFilterOptions(options);
    const statuses = status
      ? [status]
      : ["todo", "wip"];
    if (status && !VALID_STATUSES.includes(status)) {
      console.error(`Invalid status "${status}". Use: ${VALID_STATUSES.join(", ")}`);
      process.exit(1);
    }
    const db = getDb();
    const query = {
      joins: ["JOIN memory_tags mt1 ON m.id = mt1.memory_id"],
      wheres: [`mt1.tag IN (${statuses.map(() => "?").join(", ")})`],
      params: [...statuses],
    };
    applyFilters(query, { from, to, tags, all, tagAlias: "mt2" });

    const effectiveLimit = limit || tail ? limit : 20;
    const { rows, total } = queryMemories(db, { ...query, limit: effectiveLimit, tail, offset });

    if (json) {
      console.log(JSON.stringify(rows.map((row) => formatMemory(db, row))));
    } else {
      for (const row of rows) {
        const memoryTags = getTagsForMemory(db, row.id);
        printMemory(row, memoryTags);
      }
      printPagination(rows.length, total, offset);
    }
    db.close();
  });

program
  .command("mark <id> <status>")
  .description("Set task status: todo, wip, or done")
  .action((id, status) => {
    if (!VALID_STATUSES.includes(status)) {
      console.error(`Invalid status "${status}". Use: ${VALID_STATUSES.join(", ")}`);
      process.exit(1);
    }
    setTaskStatus(Number(id), status);
  });

program
  .command("edit <id> [text...]")
  .description("Replace a memory's content (archives the original)")
  .option("--json", "Output as JSON")
  .action(async (id, textParts, options) => {
    readInput(textParts, async (newText) => {
      const db = getDb();
      const old = db.prepare("SELECT id, timestamp, content FROM memories WHERE id = ?").get(Number(id));
      if (!old) {
        db.close();
        console.log(`No memory found with id ${id}.`);
        return;
      }
      const oldTags = getTagsForMemory(db, old.id).filter((t) => t !== "archived");
      db.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, 'archived')").run(old.id);
      const { lastInsertRowid } = db.prepare("INSERT INTO memories (content) VALUES (?)").run(newText);
      const insertTag = db.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)");
      for (const tag of oldTags) {
        insertTag.run(lastInsertRowid, tag);
      }
      const buf = await embed(newText);
      db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(buf, lastInsertRowid);
      const row = db.prepare("SELECT id, timestamp, content FROM memories WHERE id = ?").get(lastInsertRowid);
      const newTags = getTagsForMemory(db, lastInsertRowid);
      db.close();
      if (options.json) {
        console.log(JSON.stringify({ id: row.id, timestamp: row.timestamp, content: row.content, tags: newTags }));
      } else {
        console.log(`Memory ${old.id} archived. New memory stored as ${row.id}.`);
        printMemoryPreview(row, newTags);
      }
    });
  });

program
  .command("tag <id> <tag>")
  .description("Add a tag to a memory")
  .action((id, tag) => {
    withMemory(id, (db, row) => {
      db.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(row.id, tag);
      const tags = getTagsForMemory(db, row.id);
      db.close();
      console.log(`Memory ${id} [${tags.join(", ")}]`);
    });
  });

program
  .command("untag <id> <tag>")
  .description("Remove a tag from a memory")
  .action((id, tag) => {
    withMemory(id, (db, row) => {
      const changes = db.prepare("DELETE FROM memory_tags WHERE memory_id = ? AND tag = ?").run(row.id, tag).changes;
      if (changes === 0) {
        db.close();
        console.log(`Memory ${id} does not have tag "${tag}".`);
        return;
      }
      const tags = getTagsForMemory(db, row.id);
      db.close();
      console.log(`Memory ${id}${formatTagSuffix(tags)}`);
    });
  });

program
  .command("rm <id>")
  .description("Soft-delete a memory (tag as archived)")
  .action((id) => {
    withMemory(id, (db, row) => {
      const tags = getTagsForMemory(db, row.id);
      if (tags.includes("archived")) {
        db.close();
        console.log(`Memory ${id} is already archived.`);
        return;
      }
      db.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, 'archived')").run(row.id);
      db.close();
      console.log(`Memory ${id} archived.`);
    });
  });

program
  .command("restore <id>")
  .description("Restore an archived memory")
  .action((id) => {
    withMemory(id, (db, row) => {
      const tags = getTagsForMemory(db, row.id);
      if (!tags.includes("archived")) {
        db.close();
        console.log(`Memory ${id} is not archived.`);
        return;
      }
      db.prepare("DELETE FROM memory_tags WHERE memory_id = ? AND tag = 'archived'").run(row.id);
      db.close();
      console.log(`Memory ${id} restored.`);
    });
  });

program
  .command("status")
  .description("Overview of open tasks and recent memories")
  .option("--json", "Output as JSON")
  .action((options) => {
    const db = getDb();

    const taskQuery = {
      joins: ["JOIN memory_tags mt1 ON m.id = mt1.memory_id"],
      wheres: ["mt1.tag IN ('todo', 'wip')"],
      params: [],
    };
    applyFilters(taskQuery, {});
    const { rows: tasks } = queryMemories(db, { ...taskQuery });

    const recentQuery = { joins: [], wheres: ["1=1"], params: [] };
    applyFilters(recentQuery, {});
    const { rows: recent } = queryMemories(db, { ...recentQuery, tail: 20 });

    if (options.json) {
      console.log(JSON.stringify({
        tasks: tasks.map((row) => formatMemory(db, row)),
        recent: recent.map((row) => formatMemory(db, row)),
      }));
      db.close();
      return;
    }

    console.log(`Tasks (${tasks.length} open):`);
    if (tasks.length === 0) {
      console.log("  No open tasks.\n");
    } else {
      for (const row of tasks) {
        const tags = getTagsForMemory(db, row.id);
        const status = tags.find((t) => VALID_STATUSES.includes(t)) || "todo";
        const otherTags = tags.filter((t) => !VALID_STATUSES.includes(t) && t !== "task");
        const firstLine = row.content.split("\n")[0];
        console.log(`  [${row.id}] [${status}]${formatTagSuffix(otherTags)} ${firstLine}`);
      }
      console.log();
    }

    console.log("Recent:");
    for (const row of recent) {
      const tags = getTagsForMemory(db, row.id);
      const firstLine = row.content.split("\n")[0];
      console.log(`  [${row.id}]${formatTagSuffix(tags)} ${firstLine}`);
    }

    db.close();
  });

addFilterOptions(
  program
    .command("similar <text>")
    .description("Find semantically similar memories")
).action(async (text, options) => {
    const { tags, from, to, all, limit, tail, offset, json } = parseFilterOptions(options);
    const queryBuf = await embed(text);
    const queryVec = new Float32Array(queryBuf.buffer, queryBuf.byteOffset, queryBuf.byteLength / 4);
    const db = getDb();
    const query = { joins: [], wheres: ["m.embedding IS NOT NULL"], params: [] };
    applyFilters(query, { from, to, tags, all });
    const sql = `SELECT m.id, m.timestamp, m.content, m.embedding FROM memories m
      ${query.joins.join(" ")}
      WHERE ${query.wheres.join(" AND ")}`;
    const rows = db.prepare(sql).all(...query.params);
    const scored = rows.map((row) => {
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      return { id: row.id, timestamp: row.timestamp, content: row.content, similarity: cosineSimilarity(queryVec, vec) };
    });
    scored.sort((a, b) => b.similarity - a.similarity);
    const effectiveOffset = offset || 0;
    const count = limit || tail || 10;
    const sliced = tail
      ? scored.slice(Math.max(0, scored.length - effectiveOffset - count), scored.length - effectiveOffset).reverse()
      : scored.slice(effectiveOffset, effectiveOffset + count);
    const total = scored.length;
    if (json) {
      console.log(JSON.stringify(sliced.map((r) => ({
        ...r,
        tags: getTagsForMemory(db, r.id),
        similarity: Math.round(r.similarity * 1000) / 1000,
      }))));
    } else {
      for (const r of sliced) {
        const tags = getTagsForMemory(db, r.id);
        const sim = Math.round(r.similarity * 1000) / 1000;
        const lines = r.content.split("\n");
        const preview = lines.slice(0, 3).join("\n");
        const ellipsis = lines.length > 3 ? "\n[...]" : "";
        console.log(`[${r.id}] [${r.timestamp}]${formatTagSuffix(tags)} (${sim})\n${preview}${ellipsis}\n`);
      }
      printPagination(sliced.length, total, effectiveOffset);
    }
    db.close();
  });

program
  .command("embed")
  .description("Generate embeddings for all memories that lack them")
  .action(async () => {
    const db = getDb();
    const rows = db.prepare("SELECT id, content FROM memories WHERE embedding IS NULL").all();
    if (rows.length === 0) {
      console.log("All memories already have embeddings.");
      db.close();
      return;
    }
    console.log(`Generating embeddings for ${rows.length} memories...`);
    const update = db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
    for (let i = 0; i < rows.length; i++) {
      const buf = await embed(rows[i].content);
      update.run(buf, rows[i].id);
      process.stdout.write(`\r  ${i + 1}/${rows.length}`);
    }
    console.log("\nDone.");
    db.close();
  });

program.parse();
