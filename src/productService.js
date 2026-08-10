// Cadastro Mestre de Produtos — fonte única de informação de produto para todo o
// sistema (estoque, kits, financeiro, dashboard, conselho). Nenhum outro módulo
// duplica dado de produto: todos leem daqui (tabela `products`, já usada por
// stockIntents.js e kitService.js desde o início — este arquivo só formaliza e
// centraliza a escrita, os cálculos de preço e a validação).
const db = require('../db');
const { logAudit } = require('./audit');
const { simulatePricing } = require('./pricing');

function findSupplierByName(name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE').get(name);
}

function getOrCreateSupplier(name, actorUser) {
  if (!name) return null;
  let supplier = findSupplierByName(name);
  if (!supplier) {
    const info = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name);
    supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid);
    logAudit({ actorUserId: actorUser?.id, actorLabel: 'CEO (via cadastro de produto)', action: 'supplier.created', entityType: 'supplier', entityId: supplier.id, details: { name } });
  }
  return supplier;
}

/** Aplica a regra de precificação (geral de Renata, ou override do próprio produto)
 * a um custo de compra. Nenhum cálculo é feito "à mão" em nenhum outro módulo —
 * todos que precisam de preço de produto chamam esta função. */
function computePricing(costCents, { commissionOverride, activeRule } = {}) {
  const rule = {
    cost_multiplier: activeRule.cost_multiplier,
    commission_pct: commissionOverride != null ? commissionOverride : activeRule.commission_pct,
    premium_multiplier: activeRule.premium_multiplier,
  };
  const sim = simulatePricing(costCents, rule);
  // Preço promocional seguro (MVP): ponto de equilíbrio + 10% de margem de
  // segurança — nunca abaixo disso, mesmo em promoção, ou a venda dá prejuízo.
  const promoPriceCents = Math.round(sim.min_price_cents * 1.1);
  return { ...sim, promo_price_cents: promoPriceCents };
}

function rowToProduct(row) {
  if (!row) return null;
  return row;
}

function getProduct(id) {
  return rowToProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}

function getProductByName(name) {
  return rowToProduct(db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE').get(name));
}

function listProducts({ activeOnly = false } = {}) {
  const sql = activeOnly ? 'SELECT * FROM products WHERE active = 1 ORDER BY name' : 'SELECT * FROM products ORDER BY name';
  return db.prepare(sql).all();
}

/**
 * Cria (ou atualiza, se já existir pelo nome) um produto no Cadastro Mestre,
 * calculando automaticamente preço mínimo/ideal/promocional a partir do custo
 * informado — "nenhum cálculo deve ser manual".
 */
function upsertProduct(data, actorUser, activeRule) {
  const existing = getProductByName(data.name);
  const supplier = getOrCreateSupplier(data.supplier_name, actorUser);

  let pricing = null;
  if (data.purchase_cost_cents) {
    pricing = computePricing(data.purchase_cost_cents, { commissionOverride: data.commission_pct_override, activeRule });
  }

  const fields = {
    name: data.name,
    category: data.category || existing?.category || null,
    brand: data.brand || existing?.brand || null,
    default_supplier_id: supplier ? supplier.id : (existing?.default_supplier_id || null),
    internal_code: data.internal_code || existing?.internal_code || null,
    barcode: data.barcode || existing?.barcode || null,
    description: data.description || existing?.description || null,
    unit: data.unit || existing?.unit || 'unidade',
    photo_url: data.photo_url || existing?.photo_url || null,
    last_purchase_cost_cents: data.purchase_cost_cents || existing?.last_purchase_cost_cents || null,
    commission_pct_override: data.commission_pct_override != null ? data.commission_pct_override : (existing?.commission_pct_override ?? null),
    target_margin_pct: data.target_margin_pct != null ? data.target_margin_pct : (existing?.target_margin_pct ?? null),
    min_price_cents: pricing ? pricing.min_price_cents : (existing?.min_price_cents || null),
    ideal_price_cents: pricing ? pricing.recommended_price_cents : (existing?.ideal_price_cents || null),
    promo_price_cents: pricing ? pricing.promo_price_cents : (existing?.promo_price_cents || null),
    low_stock_threshold: data.low_stock_threshold || existing?.low_stock_threshold || 5,
    notes: data.notes || existing?.notes || null,
  };

  let product;
  if (existing) {
    db.prepare(`UPDATE products SET category=?, brand=?, default_supplier_id=?, internal_code=?, barcode=?,
      description=?, unit=?, photo_url=?, last_purchase_cost_cents=?, commission_pct_override=?, target_margin_pct=?,
      min_price_cents=?, ideal_price_cents=?, promo_price_cents=?, low_stock_threshold=?, notes=? WHERE id=?`).run(
      fields.category, fields.brand, fields.default_supplier_id, fields.internal_code, fields.barcode,
      fields.description, fields.unit, fields.photo_url, fields.last_purchase_cost_cents, fields.commission_pct_override,
      fields.target_margin_pct, fields.min_price_cents, fields.ideal_price_cents, fields.promo_price_cents,
      fields.low_stock_threshold, fields.notes, existing.id
    );
    product = getProduct(existing.id);
    logAudit({ actorUserId: actorUser?.id, actorLabel: 'CEO', action: 'product.updated', entityType: 'product', entityId: product.id, details: { name: product.name } });
  } else {
    const info = db.prepare(`INSERT INTO products (
      name, category, brand, default_supplier_id, internal_code, barcode, description, unit, photo_url,
      last_purchase_cost_cents, commission_pct_override, target_margin_pct, min_price_cents, ideal_price_cents,
      promo_price_cents, low_stock_threshold, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fields.name, fields.category, fields.brand, fields.default_supplier_id, fields.internal_code, fields.barcode,
      fields.description, fields.unit, fields.photo_url, fields.last_purchase_cost_cents, fields.commission_pct_override,
      fields.target_margin_pct, fields.min_price_cents, fields.ideal_price_cents, fields.promo_price_cents,
      fields.low_stock_threshold, fields.notes
    );
    product = getProduct(info.lastInsertRowid);
    logAudit({ actorUserId: actorUser?.id, actorLabel: 'CEO', action: 'product.created', entityType: 'product', entityId: product.id, details: { name: product.name } });
  }
  return { product, pricing, supplier };
}

function archiveProduct(id, actorUser) {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
  logAudit({ actorUserId: actorUser?.id, actorLabel: 'CEO', action: 'product.archived', entityType: 'product', entityId: id });
  return getProduct(id);
}

module.exports = {
  getProduct, getProductByName, listProducts, upsertProduct, archiveProduct, computePricing, getOrCreateSupplier, findSupplierByName,
};
