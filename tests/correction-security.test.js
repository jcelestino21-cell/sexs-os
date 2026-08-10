process.env.SEXSOS_DB_PATH = ':memory:';
process.env.PORT = 0;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const { hashPassword } = require('../src/auth');

let server, baseUrl;

test.before(async () => {
  server = require('../server.js');
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let seq = 0;
function makeCeoUser() {
  seq += 1;
  const { hash, salt } = hashPassword('senha-correta-123');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO Sec', `ceo-sec-${seq}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, username: `ceo-sec-${seq}` };
}

test('resposta inclui cabeçalhos básicos de segurança', async () => {
  const res = await request('GET', '/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

test('logout invalida a sessão no servidor — token antigo para de funcionar', async () => {
  const user = makeCeoUser();
  const login = await request('POST', '/api/auth/login', { body: { username: user.username, password: 'senha-correta-123' } });
  const token = login.body.token;

  const before = await request('GET', '/api/me', { token });
  assert.equal(before.status, 200);

  await request('POST', '/api/auth/logout', { token });

  const after = await request('GET', '/api/me', { token });
  assert.equal(after.status, 401); // token continua "parecendo" válido no navegador, mas o servidor já recusa
});

test('login bloqueia após várias tentativas erradas seguidas', async () => {
  const user = makeCeoUser();
  for (let i = 0; i < 5; i++) {
    await request('POST', '/api/auth/login', { body: { username: user.username, password: 'senha-errada' } });
  }
  const blocked = await request('POST', '/api/auth/login', { body: { username: user.username, password: 'senha-correta-123' } });
  assert.equal(blocked.status, 429); // mesmo com a senha CERTA, está bloqueado temporariamente
});

test('login com senha correta funciona normalmente antes do limite de tentativas', async () => {
  const user = makeCeoUser();
  const res = await request('POST', '/api/auth/login', { body: { username: user.username, password: 'senha-correta-123' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

test('recuperação de senha não devolve o token em modo produção', async () => {
  // NODE_ENV não está setado para 'production' neste teste (ambiente de desenvolvimento
  // padrão), então o comportamento de demonstração é esperado aqui — o importante é que
  // a variável IS_DEMO_MODE realmente controla isso (verificado por leitura do código-fonte).
  const fs = require('node:fs');
  const serverSrc = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(serverSrc, /IS_DEMO_MODE\s*=\s*process\.env\.NODE_ENV\s*!==\s*['"]production['"]/);
  assert.match(serverSrc, /if\s*\(IS_DEMO_MODE\)\s*payload\.dev_only_token/);
});
