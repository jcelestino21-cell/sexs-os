// Teste do que a tela da CEO passou a depender: "o pagamento deste kit já foi feito?" e
// "quanto ainda falta pagar/receber". A tabela commission_payments já existiu em DOIS
// formatos (created_at/created_by no schema.sql × paid_at/paid_by da migração
// /api/admin/fix-commission-table), e as duas formas precisam funcionar.
process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { listKits } = require('../src/kitService');

let seq = 0;
function cenario(colunas) {
  seq += 1;
  const rid = db.prepare(`INSERT INTO resellers (name, phone, status) VALUES (?, ?, 'ativa')`)
    .run(`Rev-${seq}`, `9${seq}`).lastInsertRowid;
  const uid = db.prepare(`INSERT INTO users (name, username, role, active) VALUES ('CEO','ceo-${seq}','ceo',1)`)
    .run().lastInsertRowid;
  const pid = db.prepare(`INSERT INTO products (name, unit, active, last_purchase_cost_cents, ideal_price_cents)
                          VALUES (?, 'un', 1, 100, 300)`).run(`Produto ${seq}`).lastInsertRowid;
  const fechado = db.prepare(`INSERT INTO kits (reseller_id, cycle_number, status, created_by, closed_at)
                              VALUES (?, 1, 'encerrado', ?, datetime('now'))`).run(rid, uid).lastInsertRowid;
  const conferindo = db.prepare(`INSERT INTO kits (reseller_id, cycle_number, status, created_by)
                                 VALUES (?, 2, 'aguardando_fechamento', ?)`).run(rid, uid).lastInsertRowid;
  for (const k of [fechado, conferindo]) {
    db.prepare(`INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents,
                quantity_delivered, quantity_available, quantity_pending_closure, quantity_confirmed_sold)
                VALUES (?,?,4,1000,4,2,1,1)`).run(k, pid);
  }
  db.prepare(`INSERT INTO kit_closures (kit_id, total_sold_confirmed_cents, total_commission_cents,
              total_due_to_sexs_cents, cost_of_goods_sold_cents, gross_profit_cents)
              VALUES (?,?,?,?,?,?)`).run(fechado, 4000, 1000, 3000, 500, 500);
  db.prepare(`DROP TABLE commission_payments`).run();
  db.prepare(`CREATE TABLE commission_payments (${colunas})`).run();
  if (colunas.includes('paid_at')) {
    db.prepare(`INSERT INTO commission_payments (kit_id, reseller_id, amount_cents, paid_by) VALUES (?,?,400,1)`)
      .run(fechado, rid);
  } else {
    db.prepare(`INSERT INTO commission_payments (kit_id, reseller_id, amount_cents, created_by) VALUES (?,?,400,1)`)
      .run(fechado, rid);
  }
  db.prepare(`INSERT INTO receivable_payments (reseller_id, kit_id, amount_cents, created_by) VALUES (?,?,1000,1)`)
    .run(rid, fechado);
  const rows = listKits({ resellerId: rid });
  return {
    pago: rows.find((r) => r.id === fechado),
    aberto: rows.find((r) => r.id === conferindo),
  };
}

test('listKits informa pago / a pagar / acerto a receber a partir dos fechamentos', () => {
  const { pago, aberto } = cenario(`id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id INTEGER NOT NULL,
    reseller_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
    paid_at TEXT NOT NULL DEFAULT (datetime('now')), paid_by INTEGER NOT NULL, notes TEXT`);
  assert.equal(pago.commission_paid_cents, 400, 'soma o que foi pago do kit');
  assert.equal(typeof pago.commission_paid_at, 'string', 'data do pagamento acompanha');
  assert.equal(pago.closure_commission_cents, 1000, 'comissão gerada no fechamento');
  assert.equal(pago.commission_due_cents, 600, 'a pagar = gerada - paga');
  assert.equal(pago.receivable_open_cents, 2000, 'a receber = devido à SexS - já recebido');
  assert.equal(pago.pending_value_cents, 1000, 'valor ainda em conferência (1 un × R$10)');
  assert.equal(aberto.commission_due_cents, 0, 'kit sem fechamento não tem comissão devida');
  assert.equal(aberto.receivable_open_cents, 0, 'kit sem fechamento não tem acerto a receber');
});

test('funciona também no formato antigo da tabela (created_at/created_by)', () => {
  const { pago } = cenario(`id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id INTEGER, reseller_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL, created_by INTEGER, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))`);
  assert.equal(pago.commission_paid_cents, 400, 'lê o pagamento mesmo sem coluna paid_at');
  assert.equal(typeof pago.commission_paid_at, 'string', 'data cai no created_at');
  assert.equal(pago.commission_due_cents, 600, 'conta a pagar continua certa');
});
