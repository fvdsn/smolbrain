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
      "INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );
    for (const tag of tags) {
      insert.run(lastInsertRowid, tag);
    }
  }
  db.close();
}

function getTagsForMemory(db, memoryId) {
  return db
    .prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag")
    .all(memoryId)
    .map((r) => r.tag);
}

function printMemory(row, tags) {
  const tagSuffix = tags && tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  console.log(`[${row.id}] [${row.timestamp}]${tagSuffix}\n${row.content}`);
}

function remember(from, to, tags) {
  const db = getDb();
  let rows;
  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => "?").join(", ");
    rows = db
      .prepare(
        `SELECT DISTINCT m.id, m.timestamp, m.content FROM memories m
         JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE m.timestamp >= ? AND m.timestamp <= ? AND mt.tag IN (${placeholders})
         ORDER BY m.timestamp`
      )
      .all(from, to, ...tags);
  } else {
    rows = db
      .prepare(
        "SELECT id, timestamp, content FROM memories WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp"
      )
      .all(from, to);
  }

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

function search(text, tags) {
  const db = getDb();
  let rows;
  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => "?").join(", ");
    rows = db
      .prepare(
        `SELECT DISTINCT m.id, m.timestamp, m.content FROM memories m
         JOIN memory_tags mt ON m.id = mt.memory_id
         WHERE m.content LIKE ? AND mt.tag IN (${placeholders})
         ORDER BY m.timestamp`
      )
      .all(`%${text}%`, ...tags);
  } else {
    rows = db
      .prepare(
        "SELECT id, timestamp, content FROM memories WHERE content LIKE ? ORDER BY timestamp"
      )
      .all(`%${text}%`);
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
    if (textParts.length > 0) {
      store(textParts.join(" "), options.tag);
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
        store(text, options.tag);
      });
    }
  });

program
  .command("remember <from> <to>")
  .description("List memories between two ISO timestamps")
  .option("--tags <tags...>", "Filter by tag(s)")
  .action((from, to, options) => {
    remember(from, to, options.tags);
  });

program
  .command("remember-by-id <id>")
  .description("Retrieve a single memory by its ID")
  .action((id) => {
    rememberById(Number(id));
  });

program
  .command("search <text>")
  .description("Search memories by content (case insensitive)")
  .option("--tags <tags...>", "Filter by tag(s)")
  .action((text, options) => {
    search(text, options.tags);
  });

program.parse();
