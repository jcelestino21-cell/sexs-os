// Restauração a partir de um backup (Correção: instrução de restauração TESTADA,
// não só documentada). Uso: node scripts/restore.js caminho/para/backup.db
//
// Faz uma cópia de segurança do banco atual antes de sobrescrever, para que uma
// restauração errada nunca seja o único caminho sem volta.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'sexsos.db');

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); }));
}

async function run() {
  const backupPath = process.argv[2];
  if (!backupPath) {
    console.error('Uso: node scripts/restore.js caminho/para/backup.db');
    process.exit(1);
  }
  if (!fs.existsSync(backupPath)) {
    console.error(`Arquivo de backup não encontrado: ${backupPath}`);
    process.exit(1);
  }

  if (fs.existsSync(DB_PATH)) {
    const skipConfirm = process.env.SEXSOS_RESTORE_YES === '1'; // usado pelo teste automatizado
    if (!skipConfirm) {
      const answer = await confirm(`Isso vai SUBSTITUIR o banco atual (${DB_PATH}) pelo backup. Continuar? (digite "sim") `);
      if (answer !== 'sim') { console.log('Cancelado.'); return; }
    }
    const safetyPath = DB_PATH + `.antes-de-restaurar-${Date.now()}`;
    fs.copyFileSync(DB_PATH, safetyPath);
    console.log(`Estado atual salvo em ${safetyPath} antes de restaurar.`);
  }

  fs.copyFileSync(backupPath, DB_PATH);
  console.log(`Restaurado com sucesso a partir de ${backupPath}.`);
}

run();
