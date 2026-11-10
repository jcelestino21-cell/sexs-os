process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
const catalog = require('../src/catalogService');

// A vitrine pública é o único canto do sistema sem login. O que este arquivo garante:
//  - nada de preço/custo/comissão/margem sai no JSON (o pedido da CEO é explícito);
//  - "disponível" vem de kit ABERTO de revendedora ATIVA ou do estoque da empresa;
//  - desativar a revendedora tira ela e o estoque dela da vitrine;
//  - produto inativo não aparece; produto sem estoque aparece como "sob encomenda";
//  - o número de WhatsApp é normalizado para o formato do link wa.me e a saudação da
//    mensagem usa o nome da pessoa, não o rótulo do contato.
let n = 0;
function uid() { n += 1; return n; }

function makeCeo() {
  const { hash, salt } = hashPassword('demo');
  const id = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-cat-${uid()}`, 'ceo', hash, salt).lastInsertRowid;
  return { id, role: 'ceo' };
}

function reseller(name, { active = true, phone = '(16) 99111-2222' } = {}) {
  return db.prepare('INSERT INTO resellers (name, status, commission_pct, phone) VALUES (?, ?, 0.25, ?)')
    .run(name, active ? 'ativa' : 'inativa', phone).lastInsertRowid;
}

function product(name, { active = true, price = 2502, cost = 800, depot = 0, description = '', photo = '' } = {}) {
  const id = db.prepare('INSERT INTO products (name, category, description, photo_url, unit, ideal_price_cents, min_price_cents, last_purchase_cost_cents, active) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(name, 'Geral', description, photo, 'unidade', price, Math.round(price * 0.6), cost, active ? 1 : 0).lastInsertRowid;
  if (cost) db.prepare('INSERT INTO stock_lots (product_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,1)').run(id, 10, cost);
  if (depot) db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason) VALUES (?, 'entrada', ?, ?, 'compra')").run(id, depot, depot);
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

/** Kit entregue (aberto) com `inHand` unidades em mãos da revendedora. */
function deliveredKit(resellerId, productId, inHand, { status = 'entregue' } = {}) {
  const kitId = db.prepare('INSERT INTO kits (reseller_id, cycle_number, status, created_by, delivered_at) VALUES (?,?,?,?,datetime(\'now\'))')
    .run(resellerId, uid(), status, 1).lastInsertRowid;
  const delivered = inHand + 1;
  db.prepare(`INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents, quantity_delivered, quantity_available, quantity_confirmed_sold)
              VALUES (?,?,?,?,?,?,?)`)
    .run(kitId, productId, delivered, 2502, delivered, inHand, 1);
  db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason) VALUES (?, 'entrega_kit', ?, 0, 'entrega')")
    .run(productId, -delivered);
  return kitId;
}

function findProduct(payload, name) {
  return payload.products.find((p) => p.name === name);
}

test('catálogo traz só nome, categoria, descrição, foto e quem entrega — nunca preço', () => {
  const ceo = makeCeo();
  const rA = reseller('Ana Ativa');
  const prod = product('Bolinha de Teste', { depot: 4, description: 'Uma bolinha.', photo: 'https://exemplo.com/a.jpg' });
  deliveredKit(rA, prod.id, 2);

  const out = catalog.publicPayload();
  assert.equal(out.enabled, true);
  assert.equal(out.brand, 'SexS');
  const p = findProduct(out, 'Bolinha de Teste');
  assert.ok(p, 'produto ativo aparece na vitrine');
  assert.deepEqual(Object.keys(p).sort(), ['available', 'category', 'description', 'holders', 'id', 'name', 'photo_url']);
  assert.equal(p.description, 'Uma bolinha.');
  assert.equal(p.photo_url, 'https://exemplo.com/a.jpg');
  assert.equal(p.available, true);
  assert.equal(p.holders[0].name, 'Ana Ativa');
  assert.equal(p.holders[0].whatsapp, '5516991112222');
  assert.equal(p.holders[1].kind, 'estoque');
  assert.equal(p.holders[1].name, out.contact.label);
  const raw = JSON.stringify(out);
  for (const forbidden of ['price', '_cents', 'cost', 'commission', 'margin', 'quantity', 'password', 'phone', 'profit']) {
    assert.ok(!raw.includes(forbidden), `o payload público não pode conter "${forbidden}"`);
  }
});

test('revendedora inativa some da vitrine e o estoque dela deixa de contar como disponível', () => {
  const ceo = makeCeo();
  const rA = reseller('Ana Para Desativar');
  const prod = product('Produto Da Ana', { price: 3000, cost: 900 });
  deliveredKit(rA, prod.id, 3);
  assert.equal(findProduct(catalog.publicPayload(), 'Produto Da Ana').available, true, 'com ela ativa, está disponível');

  db.prepare("UPDATE resellers SET status = 'inativa' WHERE id = ?").run(rA);
  const after = catalog.publicPayload();
  assert.ok(!after.resellers.some((r) => r.name === 'Ana Para Desativar'), 'revendedora inativa some da lista');
  const p = findProduct(after, 'Produto Da Ana');
  assert.equal(p.available, false, 'sem estoque na empresa, vira item de encomenda');
  assert.deepEqual(p.holders, [], 'e o que estava com ela não é oferecido para contato');
});

test('kit em aguardando_fechamento e produto inativo ficam fora do catálogo', () => {
  const ceo = makeCeo();
  const rA = reseller('Beta Ativa');
  const pending = product('Produto Em Conferencia');
  deliveredKit(rA, pending.id, 2, { status: 'aguardando_fechamento' });
  const off = product('Produto Desativado', { active: false, depot: 9 });

  const out = catalog.publicPayload();
  assert.equal(findProduct(out, 'Produto Em Conferencia').available, false, 'unidade em conferência de fechamento não é "pronta"');
  assert.ok(!out.products.some((p) => p.name === 'Produto Desativado'), 'produto inativo não aparece, nem com estoque');
});

test('contato do estoque: número normalizado, saudação sem o prefixo de cargo', () => {
  makeCeo();
  const saved = catalog.saveSettings({ contact_label: 'CEO-Jéssica', contact_whatsapp: '(16) 99999-0000' }, { id: 1, role: 'ceo' });
  assert.equal(saved.contact_whatsapp, '5516999990000');
  assert.equal(saved.contact_label, 'CEO-Jéssica');
  const out = catalog.publicPayload();
  assert.equal(out.contact.whatsapp, '5516999990000');
  assert.equal(out.contact.greeting, 'Jéssica', 'a cliente escreve "Oi Jéssica", não "Oi CEO-Jéssica"');
  assert.equal(catalog.normalizeWhatsapp('16994181014'), '5516994181014');
  assert.equal(catalog.normalizeWhatsapp('5516994181014'), '5516994181014');
  assert.equal(catalog.normalizeWhatsapp('123'), null, 'número incompleto não gera link quebrado');
  assert.equal(catalog.greetingName('Depósito SexS'), 'SexS', 'lugar vira marca, não vocativo');
  assert.equal(catalog.greetingName('Flávia Souza'), 'Flávia');
  assert.equal(catalog.greetingName('CEO Jéssica'), 'Jéssica');
  assert.equal(catalog.greetingName(''), 'tudo bem');
});

test('desligar o catálogo tira os dados da resposta, e o painel da CEO continua enxergando as contas', () => {
  const ceo = makeCeo();
  product('Produto Do Depósito', { depot: 5 });
  assert.ok(catalog.publicPayload().products.length > 0);

  catalog.saveSettings({ enabled: false }, { id: ceo.id, role: 'ceo' });
  const off = catalog.publicPayload();
  assert.equal(off.enabled, false);
  assert.equal(off.products, undefined, 'sem dados de produto quando está fora do ar');
  assert.equal(off.resellers, undefined);

  const preview = catalog.publicPayload({ ignoreDisabled: true });
  assert.ok(preview.products.some((p) => p.name === 'Produto Do Depósito'), 'a CEO vê o que estaria no ar');

  catalog.saveSettings({ enabled: true }, { id: ceo.id, role: 'ceo' });
  assert.equal(catalog.publicPayload().enabled, true);
});
