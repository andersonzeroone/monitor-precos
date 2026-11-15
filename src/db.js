import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { blackFridayWindows } from './schedule.js';

const DEFAULT_SETTINGS = {
  daily_times: '08:00,20:00', // horários normais (fuso do servidor)
  drop_alert_pct: '5', // avisa quando cair pelo menos X% desde a última leitura (0 = desliga)
  whatsapp_provider: 'console', // console | callmebot | evolution | cloudapi
};

export function openDb(file = process.env.DB_FILE || 'data/monitor.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      target_price REAL,
      selector TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_price REAL,
      lowest_price REAL,
      last_checked_at TEXT,
      last_error TEXT,
      last_alert_price REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prices_by_product ON prices(product_id, checked_at);

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      apikey TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS windows (
      id INTEGER PRIMARY KEY,
      label TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      interval_min INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      result TEXT
    );
  `);

  // Migração: faixa de aviso. alert_from_price = "avisar a partir de"; target_price = "preço ideal".
  const productCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!productCols.includes('alert_from_price')) db.exec('ALTER TABLE products ADD COLUMN alert_from_price REAL');

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  // Na primeira execução, já deixa cadastradas as janelas da próxima Black Friday.
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'windows_seeded'").get();
  if (!seeded) {
    const ins = db.prepare('INSERT INTO windows (label, starts_at, ends_at, interval_min) VALUES (?, ?, ?, ?)');
    for (const w of blackFridayWindows(new Date())) ins.run(w.label, w.starts_at, w.ends_at, w.interval_min);
    db.prepare("INSERT INTO settings (key, value) VALUES ('windows_seeded', '1')").run();
  }
  return db;
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

export function listWindows(db) {
  return db.prepare('SELECT * FROM windows ORDER BY starts_at').all();
}
