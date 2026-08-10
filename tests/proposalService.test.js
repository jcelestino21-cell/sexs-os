process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
const proposalService = require('../src/proposalService');
require('../src/stockIntents');

let ceoCounter = 0;
function makeCeo() {
  ceoCounter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db
    .prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-test-${ceoCounter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}

function seedRule(userId) {
  db.prepare(
    `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by)
     VALUES (1, 3.0, 0.30, 1.3, 1, ?)`
  ).run(userId);
}

test('fluxo completo: mensagem -> proposta -> aprovação -> estoque gravado (teste de aceitação 1 e 9)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);

  const result = await proposalService.handleDirectorMessage({
    thread: 'diego',
    text: 'Comprei 50 unidades do Lubrificante Morango por R$ 18 cada, do fornecedor Gall.',
    userId: ceo.id,
  });

  assert.ok(result.proposal);
  assert.equal(result.proposal.status, 'pendente');

  const before = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements').get();
  assert.equal(before.bal, 0); // nada gravado antes da aprovação

  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  assert.equal(executed.status, 'executada');

  const product = db.prepare('SELECT * FROM products WHERE name = ?').get('Lubrificante Morango');
  assert.ok(product);
  const balance = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(product.id);
  assert.equal(balance.bal, 50);
});

test('não permite aprovar a mesma proposta duas vezes (idempotência / sem duplicar estoque)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await proposalService.handleDirectorMessage({
    thread: 'diego',
    text: 'Comprei 10 unidades do Produto Teste por R$ 5 cada, do fornecedor F.',
    userId: ceo.id,
  });
  proposalService.approveAndExecute(result.proposal.id, ceo);
  assert.throws(() => proposalService.approveAndExecute(result.proposal.id, ceo), /já está em status/);
});

test('rejeitar uma proposta não grava movimentação de estoque', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await proposalService.handleDirectorMessage({
    thread: 'diego',
    text: 'Comprei 5 unidades do Outro Produto por R$ 2 cada, do fornecedor X.',
    userId: ceo.id,
  });
  const rejected = proposalService.reject(result.proposal.id, ceo, 'preço errado');
  assert.equal(rejected.status, 'rejeitada');
  const product = db.prepare('SELECT * FROM products WHERE name = ?').get('Outro Produto');
  assert.equal(product, undefined); // produto não deve ter sido criado
});

test('mensagem sem dado essencial pergunta em vez de assumir (não inventa fornecedor)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await proposalService.handleDirectorMessage({
    thread: 'diego',
    text: 'Comprei 20 unidades do Produto Incompleto por R$ 9 cada.',
    userId: ceo.id,
  });
  assert.equal(result.proposal, null);
  assert.match(result.reply, /fornecedor/);
});
