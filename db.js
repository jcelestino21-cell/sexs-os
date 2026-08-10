// Conexão central com o banco — compatível com Node 22+ (node:sqlite) e Node 20 (better-sqlite3).
// Tenta o módulo nativo primeiro; se não existir (Node < 22), cai para better-sqlite3.
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.SEXSOS_DB_PATH || path.join(DATA_DIR, 'sexsos.db');
if (!process.env.SEXSOS_DB_PATH && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db;
try {
  // Node 22+: módulo nativo (experimental)
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
} catch (e) {
  // Node 20 ou ambiente sem node:sqlite: usa better-sqlite3
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
}

function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  addMissingColumns();
}

const COLUMN_MIGRATIONS = {
  products: [
    ['brand', 'TEXT'],
    ['default_supplier_id', 'INTEGER REFERENCES suppliers(id)'],
    ['internal_code', 'TEXT'],
    ['barcode', 'TEXT'],
    ['description', 'TEXT'],
    ['unit', "TEXT NOT NULL DEFAULT 'unidade'"],
    ['photo_url', 'TEXT'],
    ['last_purchase_cost_cents', 'INTEGER'],
    ['commission_pct_override', 'REAL'],
    ['target_margin_pct', 'REAL'],
    ['min_price_cents', 'INTEGER'],
    ['ideal_price_cents', 'INTEGER'],
    ['promo_price_cents', 'INTEGER'],
    ['notes', 'TEXT'],
  ],
};

function addMissingColumns() {
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, def] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }
}

migrate();

module.exports = db;
