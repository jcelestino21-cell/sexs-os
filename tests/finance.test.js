process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
const proposalService = require('../src/proposalService');
const financeService = require('../src/financeService');
const { parseExpenseMessage, parsePricingProposalMessage } = require('../src/events');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db
    .prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-fin-${counter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}

function seedRule(userId) {
  db.prepare(
    `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by)
     VALUES (1, 3.0, 0.30, 1.3, 1, ?)`
  ).run(userId);
}

test('reconhece despesa em linguagem natural', async () => {
  const r = parseExpenseMessage('Paguei R$ 200 de internet do escritório, categoria despesas fixas');
  assert.equal(r.recognized, true);
  assert.equal(r.entities.amount_raw, '200');
  assert.equal(r.entities.description, 'internet do escritório');
  assert.equal(r.entities.category, 'despesas fixas');
});

test('reconhece proposta de nova política de preço', async () => {
  const r = parsePricingProposalMessage('Renata, proponha comissão de 25% e multiplicador de 3.5');
  assert.equal(r.recognized, true);
  assert.equal(r.entities.commission_pct, 0.25);
  assert.equal(r.entities.cost_multiplier, 3.5);
});

test('fluxo completo de despesa: mensagem -> proposta -> aprovação -> registrada', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await financeService.handleRenataMessage({
    text: 'Paguei R$ 150 de aluguel do depósito, categoria despesas fixas',
    userId: ceo.id,
  });
  assert.ok(result.proposal);
  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  assert.equal(executed.status, 'executada');
  const expenses = financeService.listExpenses();
  assert.ok(expenses.some((e) => e.description === 'aluguel do depósito' && e.amount_cents === 15000));
});

test('fluxo completo de nova política de preço: aprovação troca a regra ativa e mantém histórico', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const before = proposalService.getActivePricingRule();

  const result = await financeService.handleRenataMessage({
    text: 'Proponha comissão de 25% e multiplicador de 4',
    userId: ceo.id,
  });
  assert.ok(result.proposal);
  assert.equal(result.proposal.risk_level, 'alto');

  proposalService.approveAndExecute(result.proposal.id, ceo);

  const after = proposalService.getActivePricingRule();
  assert.equal(after.commission_pct, 0.25);
  assert.equal(after.cost_multiplier, 4);
  assert.equal(after.proposed_by_director, 'renata');
  assert.equal(after.version, before.version + 1);

  const stillThere = db.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(before.id);
  assert.equal(stillThere.active, 0); // desativada, mas não apagada (histórico preservado)
});

test('resumo financeiro agrega despesas mesmo sem nenhum kit fechado', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await financeService.handleRenataMessage({ text: 'Paguei R$ 50 de material de escritório', userId: ceo.id });
  proposalService.approveAndExecute(result.proposal.id, ceo);
  const summary = financeService.financialSummary();
  assert.ok(summary.expenses_cents >= 5000);
});
