process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const proposalService = require('../src/proposalService');
const resellerService = require('../src/resellerService');
const { parseUpdateResellerMessage, parseDeactivateResellerMessage } = require('../src/events');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-mem-${counter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}
function seedRule(userId) {
  db.prepare(`INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by) VALUES (1, 3.0, 0.30, 1.3, 1, ?)`).run(userId);
}
async function hire(ceo, name) {
  const result = await resellerService.handleMarinaMessage({ text: `Contratamos ${name}, telefone 11900000000, endereço Rua X, 1.`, userId: ceo.id });
  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  return executed.execution_result.resellerId;
}

test('reconhece "mudou de telefone" e "mudou de endereço"', async () => {
  const p1 = parseUpdateResellerMessage('A Yasmin mudou de telefone para 11988887777.');
  assert.equal(p1.recognized, true);
  assert.equal(p1.entities.name, 'Yasmin');
  assert.equal(p1.entities.field, 'phone');
  assert.equal(p1.entities.value, '11988887777');

  const p2 = parseUpdateResellerMessage('Fulana mudou de endereço para Rua Nova, 50.');
  assert.equal(p2.entities.field, 'address');
  assert.equal(p2.entities.value, 'Rua Nova, 50');
});

test('reconhece "saiu da empresa"', async () => {
  const p = parseDeactivateResellerMessage('Flávia saiu da empresa.');
  assert.equal(p.recognized, true);
  assert.equal(p.entities.name, 'Flávia');
});

test('atualizar telefone de revendedora via conversa, fim a fim', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  await hire(ceo, 'Yasmin');

  const result = await resellerService.handleMarinaMessage({ text: 'A Yasmin mudou de telefone para 11988887777.', userId: ceo.id });
  assert.ok(result.proposal);
  assert.equal(result.proposal.risk_level, 'baixo');
  proposalService.approveAndExecute(result.proposal.id, ceo);

  const reseller = db.prepare('SELECT * FROM resellers WHERE name = ?').get('Yasmin');
  assert.equal(reseller.phone, '11988887777');
});

test('desativar revendedora via conversa bloqueia o acesso ao portal', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const resellerId = await hire(ceo, 'Flavia');
  const userBefore = db.prepare('SELECT * FROM users WHERE reseller_id = ?').get(resellerId);
  assert.equal(userBefore.active, 1);

  const result = await resellerService.handleMarinaMessage({ text: 'Flavia saiu da empresa.', userId: ceo.id });
  assert.ok(result.proposal);
  proposalService.approveAndExecute(result.proposal.id, ceo);

  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  assert.equal(reseller.status, 'inativa');
  const userAfter = db.prepare('SELECT * FROM users WHERE reseller_id = ?').get(resellerId);
  assert.equal(userAfter.active, 0);
});

test('não inventa dado: revendedora inexistente não gera proposta', async () => {
  const ceo = makeCeo();
  const result = await resellerService.handleMarinaMessage({ text: 'A Inexistente mudou de telefone para 11900000000.', userId: ceo.id });
  assert.equal(result.proposal, null);
  assert.match(result.reply, /não encontrei/i);
});
