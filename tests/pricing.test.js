const test = require('node:test');
const assert = require('node:assert/strict');
const { simulatePricing, brlToCents, centsToBRL } = require('../src/pricing');

const RULE = { cost_multiplier: 3.0, commission_pct: 0.30, premium_multiplier: 1.3 };

test('brlToCents interpreta valores em formato BR e US corretamente', () => {
  assert.equal(brlToCents('18'), 1800);
  assert.equal(brlToCents('18,50'), 1850);
  assert.equal(brlToCents('R$ 18,00'), 1800);
  assert.equal(brlToCents(30), 3000);
});

test('teste de aceitação 2: custo x3 gera preço-base R$90 e comissão R$27 sobre venda', () => {
  const result = simulatePricing(3000, RULE); // custo R$30,00
  assert.equal(result.current_price_cents, 9000); // R$90,00
  assert.equal(result.commission_on_current_sale_cents, 2700); // R$27,00 (30% de R$90)
});

test('preço mínimo é o ponto de equilíbrio (empresa não perde dinheiro mesmo pagando comissão)', () => {
  const result = simulatePricing(1800, RULE);
  // min_price - 30%*min_price deve cobrir >= custo
  const netAtMin = result.min_price_cents - Math.round(result.min_price_cents * RULE.commission_pct);
  assert.ok(netAtMin >= result.unit_cost_cents - 1); // tolerância de 1 centavo por arredondamento
});

test('rejeita configuração matematicamente inviável (preço atual abaixo do ponto de equilíbrio)', () => {
  const inviableRule = { cost_multiplier: 1.1, commission_pct: 0.5, premium_multiplier: 1.3 };
  assert.throws(() => simulatePricing(1000, inviableRule), /inviável/);
});

test('nunca aceita custo zero ou negativo', () => {
  assert.throws(() => simulatePricing(0, RULE));
  assert.throws(() => simulatePricing(-100, RULE));
});

test('centsToBRL formata em pt-BR', () => {
  assert.equal(centsToBRL(9000), 'R$\u00a090,00');
});
