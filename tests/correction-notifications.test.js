process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const proposalService = require('../src/proposalService');
const resellerService = require('../src/resellerService');
const kitService = require('../src/kitService');
const notificationService = require('../src/notificationService');
const anaService = require('../src/anaService');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-notif-${counter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}
function seedRule(userId) {
  db.prepare(`INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by) VALUES (1, 3.0, 0.30, 1.3, 1, ?)`).run(userId);
}
async function buyStock(ceo, name, qty, costCents) {
  const result = await proposalService.handleDirectorMessage({ thread: 'diego', text: `Comprei ${qty} unidades do ${name} por R$ ${(costCents/100).toFixed(2)} cada, do fornecedor F.`, userId: ceo.id });
  proposalService.approveAndExecute(result.proposal.id, ceo);
  return db.prepare('SELECT * FROM products WHERE name = ?').get(name);
}
async function hire(ceo, name) {
  const result = await resellerService.handleMarinaMessage({ text: `Contratamos ${name}, telefone 11900000000, endereço Rua X, 1.`, userId: ceo.id });
  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  return executed.execution_result.resellerId;
}

test('informar venda gera uma notificação para a CEO (checklist item 16)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Notif A', 10, 1000);
  const resellerId = await hire(ceo, 'RevNotifA');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 10 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const before = notificationService.listForRole('ceo').length;

  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 3, resellerUser });

  const after = notificationService.listForRole('ceo');
  assert.equal(after.length, before + 1);
  assert.match(after[0].message, /RevNotifA/);
  assert.match(after[0].message, /3x/);
});

test('notificação nunca duplica para o mesmo evento, mesmo se disparada duas vezes (checklist item 18)', async () => {
  const n1 = notificationService.notify({ type: 'teste.dedup', entityType: 'kit_sale', entityId: 999999, message: 'primeira vez' });
  const n2 = notificationService.notify({ type: 'teste.dedup', entityType: 'kit_sale', entityId: 999999, message: 'segunda tentativa, mesmo evento' });
  assert.ok(n1);
  assert.equal(n2, null); // a segunda chamada não cria linha nova
  const count = db.prepare(`SELECT COUNT(*) as c FROM notifications WHERE type = 'teste.dedup' AND entity_id = 999999`).get();
  assert.equal(count.c, 1);
});

test('marcar como lida funciona e não afeta outras notificações', async () => {
  const n1 = notificationService.notify({ type: 'teste.leitura', entityType: 'x', entityId: 1, message: 'a' });
  const n2 = notificationService.notify({ type: 'teste.leitura', entityType: 'x', entityId: 2, message: 'b' });
  notificationService.markRead(n1.id);
  const unread = notificationService.listForRole('ceo', { unreadOnly: true });
  assert.ok(!unread.some((n) => n.id === n1.id));
  assert.ok(unread.some((n) => n.id === n2.id));
});

test('resumo da Ana menciona notificações não lidas (checklist item 17)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Notif B', 10, 1000);
  const resellerId = await hire(ceo, 'RevNotifB');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 10 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 2, resellerUser });

  const summary = anaService.dailySummary();
  assert.match(summary, /notificaç/i);
});
