process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const proposalService = require('../src/proposalService');
const resellerService = require('../src/resellerService');
const kitService = require('../src/kitService');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-stock-${counter}`, 'ceo', hash, salt);
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

test('reserva de estoque impede aprovar dois kits que juntos excedem o saldo físico', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Reserva', 10, 1000);
  const r1 = await hire(ceo, 'Rev1');
  const r2 = await hire(ceo, 'Rev2');

  const kitA = kitService.suggestKit({ resellerId: r1, items: [{ product_id: product.id, quantity: 7 }], userId: ceo.id });
  const kitB = kitService.suggestKit({ resellerId: r2, items: [{ product_id: product.id, quantity: 7 }], userId: ceo.id });

  kitService.approveKit(kitA.id, ceo); // reserva 7 de 10 — sobra 3 livres
  assert.throws(() => kitService.approveKit(kitB.id, ceo), /livre para reserva/); // pede 7, só há 3 livres
});

test('cancelar kit aprovado libera a reserva para outros kits', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Reserva 2', 10, 1000);
  const r1 = await hire(ceo, 'Rev3');
  const r2 = await hire(ceo, 'Rev4');

  const kitA = kitService.suggestKit({ resellerId: r1, items: [{ product_id: product.id, quantity: 8 }], userId: ceo.id });
  kitService.approveKit(kitA.id, ceo);

  const kitB = kitService.suggestKit({ resellerId: r2, items: [{ product_id: product.id, quantity: 8 }], userId: ceo.id });
  assert.throws(() => kitService.approveKit(kitB.id, ceo));

  kitService.cancelApprovedKit(kitA.id, ceo, 'teste');
  const approvedB = kitService.approveKit(kitB.id, ceo); // agora deve funcionar, reserva liberada
  assert.equal(approvedB.status, 'aprovado');
});

test('reserva é convertida (não duplicada) na entrega — saldo final bate exatamente', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Reserva 3', 10, 1000);
  const r1 = await hire(ceo, 'Rev5');
  const kit = kitService.suggestKit({ resellerId: r1, items: [{ product_id: product.id, quantity: 4 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  kitService.confirmDelivery(kit.id, ceo);

  const physicalBalance = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(product.id);
  assert.equal(physicalBalance.bal, 6); // 10 - 4, sem duplicar a baixa

  const activeReservations = db.prepare(`SELECT COUNT(*) as c FROM stock_reservations WHERE kit_id = ? AND status = 'ativa'`).get(kit.id);
  assert.equal(activeReservations.c, 0); // reserva convertida, não some sem virar movimento
});

test('não é possível cancelar um kit já entregue (reserva já convertida)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Reserva 4', 10, 1000);
  const r1 = await hire(ceo, 'Rev6');
  const kit = kitService.suggestKit({ resellerId: r1, items: [{ product_id: product.id, quantity: 4 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  kitService.confirmDelivery(kit.id, ceo);
  assert.throws(() => kitService.cancelApprovedKit(kit.id, ceo), /Só é possível cancelar/);
});
