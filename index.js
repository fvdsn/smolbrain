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
  return db;
}

function store(text) {
  const db = getDb();
  db.prepare("INSERT INTO memories (content) VALUES (?)").run(text);
  db.close();
}

function printMemory(row) {
  console.log(`[${row.id}] [${row.timestamp}] ${row.content}`);
}

function remember(from, to) {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, timestamp, content FROM memories WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp"
    )
    .all(from, to);
  db.close();

  for (const row of rows) {
    printMemory(row);
  }
}

function rememberById(id) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, timestamp, content FROM memories WHERE id = ?")
    .get(id);
  db.close();

  if (!row) {
    console.log(`No memory found with id ${id}.`);
    return;
  }
  printMemory(row);
}

function search(text) {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, timestamp, content FROM memories WHERE content LIKE ? ORDER BY timestamp"
    )
    .all(`%${text}%`);
  db.close();

  for (const row of rows) {
    printMemory(row);
  }
}

program.name("smolbrain").description("Long-term memory for AI agents");

program
  .command("store [text...]")
  .description("Store a memory (pass text as args or pipe via stdin)")
  .action((textParts) => {
    if (textParts.length > 0) {
      store(textParts.join(" "));
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
        store(text);
      });
    }
  });

program
  .command("remember <from> <to>")
  .description("List memories between two ISO timestamps")
  .action((from, to) => {
    remember(from, to);
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
  .action((text) => {
    search(text);
  });

program.parse();
