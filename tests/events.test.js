const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePurchaseMessage } = require('../src/events');

test('reconhece a mensagem de exemplo da documentação oficial', () => {
  const r = parsePurchaseMessage('Comprei 50 unidades do Lubrificante Morango por R$ 18 cada, do fornecedor Gall.');
  assert.equal(r.recognized, true);
  assert.equal(r.intent, 'compra_estoque');
  assert.equal(r.entities.quantity, 50);
  assert.equal(r.entities.product_name, 'Lubrificante Morango');
  assert.equal(r.entities.unit_price_raw, '18');
  assert.equal(r.entities.supplier_name, 'Gall');
  assert.deepEqual(r.missing, []);
});

test('teste de aceitação 4: sinaliza dado ausente em vez de assumir', () => {
  const r = parsePurchaseMessage('Comprei 50 unidades do Lubrificante Morango por R$ 18 cada.');
  assert.equal(r.recognized, true);
  assert.ok(r.missing.includes('fornecedor'));
});

test('mensagem não reconhecida não gera intenção inventada', () => {
  const r = parsePurchaseMessage('Bom dia, como estão as vendas hoje?');
  assert.equal(r.recognized, false);
  assert.equal(r.intent, 'desconhecido');
});
