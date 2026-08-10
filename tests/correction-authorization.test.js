// Testes de autorização em nível HTTP real (não só chamando funções internas) —
// precisamente porque a falha original era na camada de rotas, não na lógica de
// negócio. Sobe o servidor de verdade numa porta dedicada para estes testes.
process.env.SEXSOS_DB_PATH = ':memory:';
process.env.PORT = 0; // porta efêmera

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
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let seq = 0;
function makeDirectorUser(directorKey, name) {
  seq += 1;
  const { hash, salt } = hashPassword('senha-teste-123');
  const info = db.prepare('INSERT INTO users (name, username, role, director_key, password_hash, password_salt) VALUES (?,?,?,?,?,?)')
    .run(name, `${directorKey}-${seq}`, 'diretor', directorKey, hash, salt);
  return { id: info.lastInsertRowid, username: `${directorKey}-${seq}` };
}
function makeCeoUser() {
  seq += 1;
  const { hash, salt } = hashPassword('senha-ceo-123');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO Teste', `ceo-${seq}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, username: `ceo-${seq}` };
}
async function loginAs(username, password) {
  const res = await request('POST', '/api/auth/login', { body: { username, password } });
  return res.body.token;
}
function seedRule(userId) {
  db.prepare(`INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by) VALUES (1, 3.0, 0.30, 1.3, 1, ?)`).run(userId);
}

test('Theo recebe 403 ao tentar acessar revendedoras completas, documentos pessoais e financeiro detalhado', async () => {
  const theoUser = makeDirectorUser('theo', 'Theo');
  const token = await loginAs(theoUser.username, 'senha-teste-123');
  assert.ok(token, 'login do Theo deveria funcionar');

  const resellers = await request('GET', '/api/resellers', { token });
  assert.equal(resellers.status, 403);

  const docs = await request('GET', '/api/resellers/1/documents', { token });
  assert.equal(docs.status, 403);

  const financial = await request('GET', '/api/financial/summary', { token });
  assert.equal(financial.status, 403);

  const campaigns = await request('GET', '/api/marketing/campaigns', { token });
  assert.equal(campaigns.status, 200);
});

test('Marina recebe 403 ao tentar ler dados financeiros/preço', async () => {
  const marinaUser = makeDirectorUser('marina', 'Marina');
  const token = await loginAs(marinaUser.username, 'senha-teste-123');

  const financial = await request('GET', '/api/financial/summary', { token });
  assert.equal(financial.status, 403);

  const pricing = await request('GET', '/api/pricing-rule', { token });
  assert.equal(pricing.status, 403);

  const resellers = await request('GET', '/api/resellers', { token });
  assert.equal(resellers.status, 200);
});

test('Diego recebe 403 ao tentar acessar revendedoras completas (dados pessoais) e financeiro', async () => {
  const diegoUser = makeDirectorUser('diego', 'Diego');
  const token = await loginAs(diegoUser.username, 'senha-teste-123');

  const resellers = await request('GET', '/api/resellers', { token });
  assert.equal(resellers.status, 403);

  const financial = await request('GET', '/api/financial/summary', { token });
  assert.equal(financial.status, 403);

  const products = await request('GET', '/api/products', { token });
  assert.equal(products.status, 200);
});

test('Painel consolidado (visão cruzada) é exclusivo da CEO — diretor recebe 403', async () => {
  const ricardoUser = makeDirectorUser('ricardo', 'Ricardo');
  const token = await loginAs(ricardoUser.username, 'senha-teste-123');
  const dash = await request('GET', '/api/dashboard', { token });
  assert.equal(dash.status, 403);
});

test('diretor não consegue criar propostas nem conversar em nome da CEO', async () => {
  const diegoUser = makeDirectorUser('diego', 'Diego');
  const token = await loginAs(diegoUser.username, 'senha-teste-123');
  const res = await request('POST', '/api/messages', { token, body: { thread: 'diego', text: 'Comprei 5 unidades do X por R$ 1 cada, do fornecedor Y.' } });
  assert.equal(res.status, 403);
});

test('revendedora não consegue acessar o kit de outra revendedora trocando o ID na URL', async () => {
  const ceo = makeCeoUser();
  const ceoToken = await loginAs(ceo.username, 'senha-ceo-123');
  seedRule(ceo.id);

  const buyMsg = await request('POST', '/api/messages', { token: ceoToken, body: { thread: 'diego', text: 'Comprei 10 unidades do Produto Auth por R$ 5 cada, do fornecedor F.' } });
  await request('POST', `/api/proposals/${buyMsg.body.proposal.id}/approve`, { token: ceoToken });

  const hire1 = await request('POST', '/api/messages', { token: ceoToken, body: { thread: 'marina', text: 'Contratamos AuthUm, telefone 11900000000, endereço Rua A, 1.' } });
  const exec1 = await request('POST', `/api/proposals/${hire1.body.proposal.id}/approve`, { token: ceoToken });
  const hire2 = await request('POST', '/api/messages', { token: ceoToken, body: { thread: 'marina', text: 'Contratamos AuthDois, telefone 11900000000, endereço Rua B, 2.' } });
  const exec2 = await request('POST', `/api/proposals/${hire2.body.proposal.id}/approve`, { token: ceoToken });

  const products = await request('GET', '/api/products', { token: ceoToken });
  const productId = products.body.products.find((p) => p.name === 'Produto Auth').id;

  const suggested = await request('POST', '/api/kits/suggest', { token: ceoToken, body: { reseller_id: exec1.body.proposal.execution_result.resellerId, items: [{ product_id: productId, quantity: 3 }] } });
  await request('POST', `/api/kits/${suggested.body.kit.id}/approve`, { token: ceoToken });
  await request('POST', `/api/kits/${suggested.body.kit.id}/confirm-delivery`, { token: ceoToken });

  const token2FromApproval = exec2.body.proposal.execution_result.firstAccessToken;
  await request('POST', `/api/first-access/${token2FromApproval}/set-password`, { body: { password: 'senha-revendedora-2' } });
  const reseller2Token = await loginAs(exec2.body.proposal.execution_result.username, 'senha-revendedora-2');

  const stolenAccess = await request('GET', `/api/portal/kits/${suggested.body.kit.id}`, { token: reseller2Token });
  assert.equal(stolenAccess.status, 404);
});
