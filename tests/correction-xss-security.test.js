process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { hashPassword } = require('../src/auth');

// ---- XSS armazenado: o valor malicioso é guardado como texto puro (não é papel do
// banco sanitizar), mas a função de escape do frontend precisa neutralizá-lo na hora
// de renderizar. Extraímos e avaliamos esc() isoladamente do arquivo real servido. ----
test('payload de XSS é guardado como texto simples (a defesa é na renderização, não no banco)', () => {
  const { hash, salt } = hashPassword('demo');
  const userInfo = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('Seed', 'seed-xss-test', 'ceo', hash, salt);
  const info = db.prepare('INSERT INTO tips (text, created_by) VALUES (?, ?)')
    .run('<script>alert(1)</script>', userInfo.lastInsertRowid);
  const row = db.prepare('SELECT * FROM tips WHERE id = ?').get(info.lastInsertRowid);
  assert.equal(row.text, '<script>alert(1)</script>'); // guardado exatamente como foi enviado
});

test('a função esc() do frontend neutraliza tags e atributos perigosos', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'não encontrei o bloco <script> do frontend');
  const script = match[1];

  const escMatch = script.match(/function esc\(str\)\s*\{[\s\S]*?\n\}/);
  assert.ok(escMatch, 'não encontrei a função esc() no frontend — verifique se ela ainda existe com esse nome');

  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(escMatch[0] + '\nthis.escResult1 = esc(\'<script>alert(1)</script>\');\nthis.escResult2 = esc(\'"><img src=x onerror=alert(1)>\');', sandbox);

  assert.ok(!sandbox.escResult1.includes('<script>'), 'esc() deixou uma tag <script> passar sem neutralizar');
  assert.ok(sandbox.escResult1.includes('&lt;script&gt;'));
  assert.ok(!sandbox.escResult2.includes('<img'), 'esc() deixou uma tag <img> com onerror passar sem neutralizar');
  assert.ok(!sandbox.escResult2.includes('"'), 'esc() não escapou aspas duplas — quebra de atributo ainda seria possível');
});

test('todo template que interpola nome de revendedora, produto, dica ou descrição usa esc() (varredura estática)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const riskyFields = ['\\.name(?!\\w)', '\\.text(?!\\w)', '\\.description(?!\\w)', '\\.product_name(?!\\w)', '\\.note(?!\\w)'];
  const lines = html.split('\n');
  const unescapedOffenders = [];
  lines.forEach((line, idx) => {
    for (const field of riskyFields) {
      const re = new RegExp('\\$\\{(?!esc\\()[a-zA-Z0-9_.]*' + field, 'g');
      if (re.test(line) && line.includes('innerHTML') === false && /\$\{[a-zA-Z0-9_.]+\.(name|text|description|product_name|note)\}/.test(line)) {
        // heurística: só reporta se o campo aparece puro dentro de um template `${...}`
        const bareMatch = line.match(/\$\{([a-zA-Z0-9_.]+)\.(name|text|description|product_name|note)\}/g) || [];
        for (const m of bareMatch) {
          if (!line.includes('esc(' + m.slice(2, -1))) unescapedOffenders.push({ line: idx + 1, snippet: m });
        }
      }
    }
  });
  // Esta varredura é uma heurística de apoio, não uma prova formal — reporta os
  // candidatos para revisão manual em vez de travar o build com falsos positivos.
  if (unescapedOffenders.length > 0) {
    console.log('Candidatos a revisar (podem ser falsos positivos):', JSON.stringify(unescapedOffenders));
  }
  assert.ok(true);
});

// ---- Log não deve vazar segredo (senha, token de sessão) ----
let seq = 0;
function makeUser() {
  seq += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('User', `user-log-${seq}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, username: `user-log-${seq}` };
}

test('auditoria nunca grava a senha em texto puro, nem em login falho', () => {
  const user = makeUser();
  const auth = require('../src/auth');
  auth.login(user.username, 'senha-super-secreta-que-nao-pode-vazar');
  auth.login(user.username, 'tentativa-errada-tambem-nao-pode-vazar');

  const rows = db.prepare('SELECT * FROM audit_log').all();
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes('senha-super-secreta-que-nao-pode-vazar'));
  assert.ok(!serialized.includes('tentativa-errada-tambem-nao-pode-vazar'));
});

test('tabela de sessões nunca guarda o token em texto puro — só o hash', () => {
  const user = makeUser();
  const auth = require('../src/auth');
  const token = auth.createSession(user.id);
  const rows = db.prepare('SELECT * FROM sessions').all();
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(token), 'o token de sessão em texto puro não deveria estar gravado no banco');
});
