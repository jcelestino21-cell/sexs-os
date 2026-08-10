// Testa o ciclo real de backup/restauração via os scripts de linha de comando
// (não simula por dentro do processo) — precisamente porque a correção pede uma
// instrução de restauração TESTADA, não só escrita.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'sexsos.db');

test('backup e restauração real via scripts de linha de comando', () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  execFileSync('node', ['scripts/seed.js'], { cwd: ROOT });
  const before = execFileSync('node', ['-e', "const db=require('./db'); console.log(db.prepare('SELECT COUNT(*) as c FROM users').get().c);"], { cwd: ROOT }).toString().trim();

  execFileSync('node', ['scripts/backup.js'], { cwd: ROOT });
  const backupDir = path.join(DATA_DIR, 'backups');
  const backups = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
  assert.equal(backups.length, 1);
  const backupPath = path.join(backupDir, backups[0]);
  assert.ok(fs.statSync(backupPath).size > 0);

  // muda o banco depois do backup
  execFileSync('node', ['-e', `
    const db = require('./db');
    const { hashPassword } = require('./src/auth');
    const { hash, salt } = hashPassword('x');
    db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)').run('Temp', 'temp-restore-test', 'ceo', hash, salt);
  `], { cwd: ROOT });
  const afterChange = execFileSync('node', ['-e', "const db=require('./db'); console.log(db.prepare('SELECT COUNT(*) as c FROM users').get().c);"], { cwd: ROOT }).toString().trim();
  assert.equal(Number(afterChange), Number(before) + 1);

  // restaura
  execFileSync('node', ['scripts/restore.js', backupPath], { cwd: ROOT, env: { ...process.env, SEXSOS_RESTORE_YES: '1' } });
  const afterRestore = execFileSync('node', ['-e', "const db=require('./db'); console.log(db.prepare('SELECT COUNT(*) as c FROM users').get().c);"], { cwd: ROOT }).toString().trim();
  assert.equal(Number(afterRestore), Number(before)); // voltou ao estado do backup, não ao estado alterado

  // a cópia de segurança pré-restauração existe (restaurar nunca é via de mão única)
  const safetyFiles = fs.readdirSync(DATA_DIR).filter((f) => f.includes('antes-de-restaurar'));
  assert.ok(safetyFiles.length >= 1);

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
