// Backup local do banco (Correção: "implementar backup local e instrução de
// restauração testada"). Como o banco é um único arquivo SQLite, um backup
// consistente é uma cópia do arquivo — não precisa de ferramenta externa.
// Uso: node scripts/backup.js
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'sexsos.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function run() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Banco não encontrado em ${DB_PATH}. Rode o servidor pelo menos uma vez antes de fazer backup.`);
    process.exit(1);
  }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `sexsos-${timestamp}.db`);
  fs.copyFileSync(DB_PATH, backupPath);

  const sizeKb = (fs.statSync(backupPath).size / 1024).toFixed(1);
  console.log(`Backup criado: ${backupPath} (${sizeKb} KB)`);
  console.log(`Para restaurar: node scripts/restore.js "${backupPath}"`);
}

run();
