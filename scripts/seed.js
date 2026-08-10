// Dados de demonstração — claramente separados da operação real (Seção 5, "Implantação
// com os dados reais"). Rode com: node scripts/seed.js
// As credenciais abaixo são exclusivas do ambiente local de demonstração.
const db = require('../db');
const { hashPassword } = require('../src/auth');

function upsertUser({ name, username, role, director_key, password }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`- usuário "${username}" já existe, mantendo.`);
    return existing.id;
  }
  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (name, username, role, director_key, password_hash, password_salt) VALUES (?,?,?,?,?,?)')
    .run(name, username, role, director_key || null, hash, salt);
  console.log(`- usuário "${username}" criado (senha demo: ${password}).`);
  return info.lastInsertRowid;
}

function seedPricingRule(createdBy) {
  const active = db.prepare('SELECT id FROM pricing_rules WHERE active = 1').get();
  if (active) {
    console.log('- regra de precificação ativa já existe, mantendo.');
    return;
  }
  db.prepare(
    `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, notes, created_by)
     VALUES (1, 3.0, 0.30, 1.3, 1, 'Política atual identificada: custo x3, comissão 30% do valor vendido. Ainda não auditada por Renata.', ?)`
  ).run(createdBy);
  console.log('- regra de precificação v1 (custo x3 / comissão 30%) criada e ativada.');
}

function seedTips(createdBy) {
  const existing = db.prepare('SELECT COUNT(*) as c FROM tips').get();
  if (existing.c > 0) { console.log('- dicas já existem, mantendo.'); return; }
  const tips = [
    'Guarde os produtos em local seco e longe de luz direta — embalagem danificada não pode ser revendida.',
    'Informe a venda assim que ela acontecer. Isso evita esquecimento na hora do fechamento do mês.',
    'Dúvidas sobre um produto? Pergunte antes de vender — isso evita devolução depois.',
  ];
  for (const t of tips) db.prepare('INSERT INTO tips (text, created_by) VALUES (?,?)').run(t, createdBy);
  console.log(`- ${tips.length} dicas rápidas criadas.`);
}

function run() {
  console.log('Seed de demonstração — SexS OS');
  const ceoId = upsertUser({ name: 'CEO', username: 'ceo', role: 'ceo', password: 'sexsos-demo-2026' });
  upsertUser({ name: 'Diego', username: 'diego', role: 'diretor', director_key: 'diego', password: 'diego-demo-2026' });
  upsertUser({ name: 'Marina', username: 'marina', role: 'diretor', director_key: 'marina', password: 'marina-demo-2026' });
  upsertUser({ name: 'Renata', username: 'renata', role: 'diretor', director_key: 'renata', password: 'renata-demo-2026' });
  upsertUser({ name: 'Ricardo', username: 'ricardo', role: 'diretor', director_key: 'ricardo', password: 'ricardo-demo-2026' });
  upsertUser({ name: 'Theo', username: 'theo', role: 'diretor', director_key: 'theo', password: 'theo-demo-2026' });
  upsertUser({ name: 'Arthur', username: 'arthur', role: 'diretor', director_key: 'arthur', password: 'arthur-demo-2026' });
  seedPricingRule(ceoId);
  seedTips(ceoId);
  console.log('Concluído.');
}

run();
