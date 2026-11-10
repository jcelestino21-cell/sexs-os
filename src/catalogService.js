// Catálogo público (vitrine da cliente final), alimentado pelo próprio sistema.
//
// Por que existe um serviço separado: a página é ANÔNIMA (não tem login), então o
// payload precisa ser montado sob medida em vez de reaproveitar as consultas internas.
// Preço, custo, comissão, margem, quantidade em estoque e nome de quem ainda não tem
// cadastro ativo NÃO saem daqui — a cliente vê só nome, categoria, descrição, foto e quem
// pode entregar. Contato é sempre por WhatsApp, com a mensagem pronta.
//
// Onde está a mercadoria, na visão da cliente:
//  - "pronta para enviar" = unidade em mãos numa revendedora com kit ABERTO (status
//    'entregue') dela estar ativa; ou
//  - unidade parada no estoque da empresa (saldo físico = soma dos movimentos);
//  - sem nada disso = "sob encomenda": ela escolhe com quem encomendar.
// Kit em 'aguardando_fechamento' não conta como disponível: as unidades ali estão em
// conferência e boa parte delas está voltando para o estoque.
const db = require('../db');
const { logAudit } = require('./audit');

const SETTINGS_SQL = `CREATE TABLE IF NOT EXISTS catalog_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  contact_label TEXT NOT NULL DEFAULT 'SexS',
  contact_whatsapp TEXT,
  contact_message TEXT,
  work_with_us_message TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const DEFAULTS = {
  enabled: 1,
  contact_label: 'SexS',
  contact_whatsapp: null,
  contact_message: null,
  work_with_us_message: 'Tenho interesse em fazer parte da equipe',
};

let tableReady = false;
/** A tabela é criada sob demanda (mesmo padrão das demais rotas que precisam de uma
 * estrutura nova sem migração versionada): leitura nunca escreve. */
function ensureTable() {
  if (!tableReady) { db.exec(SETTINGS_SQL); tableReady = true; }
}

function getSettings() {
  ensureTable();
  const row = db.prepare('SELECT * FROM catalog_settings WHERE id = 1').get();
  return { ...DEFAULTS, ...(row || {}) };
}

function saveSettings(data, actorUser) {
  ensureTable();
  db.prepare(`INSERT INTO catalog_settings (id, enabled, contact_label, contact_whatsapp, work_with_us_message)
              VALUES (1, 1, 'SexS', NULL, 'Tenho interesse em fazer parte da equipe')
              ON CONFLICT(id) DO NOTHING`).run();
  // Telefone: guarda só os dígitos (com DDI 55 quando faltar), porque o link wa.me não
  // aceita máscara. Máscara de exibição fica por conta da interface.
  let whatsapp;
  if (data.contact_whatsapp !== undefined) {
    const digits = String(data.contact_whatsapp || '').replace(/\D/g, '');
    whatsapp = digits ? (digits.startsWith('55') && digits.length >= 12 ? digits : `55${digits.replace(/^55/, '')}`) : null;
  }
  const current = getSettings();
  const next = {
    enabled: data.enabled === undefined ? current.enabled : (data.enabled ? 1 : 0),
    contact_label: data.contact_label === undefined ? current.contact_label : (String(data.contact_label).trim().slice(0, 60) || 'SexS'),
    contact_whatsapp: whatsapp === undefined ? current.contact_whatsapp : whatsapp,
    work_with_us_message: data.work_with_us_message === undefined ? current.work_with_us_message : (String(data.work_with_us_message).trim().slice(0, 200) || DEFAULTS.work_with_us_message),
  };

  db.prepare(
    `UPDATE catalog_settings SET enabled = ?, contact_label = ?, contact_whatsapp = ?, work_with_us_message = ?,
       updated_by = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(next.enabled, next.contact_label, next.contact_whatsapp, next.work_with_us_message, actorUser ? actorUser.id : null);
  logAudit({
    actorUserId: actorUser ? actorUser.id : null, actorLabel: 'CEO', action: 'catalog.settings_updated',
    entityType: 'catalog_settings', entityId: 1,
    details: { enabled: next.enabled, contact_label: next.contact_label, whatsapp_set: !!next.contact_whatsapp },
  });
  return getSettings();
}

/** '(16) 99418-1014' -> '5516994181014'. Sem dígitos suficientes devolve null (a página
 * cai no link genérico do WhatsApp, que abre a lista de contatos em vez de quebrar). */
function normalizeWhatsapp(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return `55${digits}`; // completa o DDI do Brasil

}

/** Prefixos de cargo/lugar que não são nome de pessoa. "Depósito" entra aqui porque a
 * cliente não deve ser cumprimentada por um lugar. */
const ROLE_WORDS = /^(ceo|ceo\.|gerente|supervisores?|atendentes?|suporte|contato|admin|dep[óo]sito|estoque|sac)$/i;

/** Nome usado na saudação da mensagem: de "CEO-Jéssica" fica "Jéssica"; de "Depósito
 * SexS", "SexS"; de "Flávia Souza", "Flávia". O rótulo serve para identificar o contato,
 * não para ser chamado pelo nome. */
function greetingName(label) {
  const clean = String(label || '').trim();
  if (!clean) return 'tudo bem';
  const parts = clean.split(/[-–/|\s]+/).filter(Boolean);
  const personal = parts.filter((t) => {
    if (ROLE_WORDS.test(t)) return false;
    const letters = t.replace(/[^A-Za-z]/g, '');
    // siglas curtas ("CEO", "RH") não funcionam como vocativo
    if (letters && letters.length <= 4 && letters === letters.toUpperCase() && !/[À-ÿ]/.test(t)) return false;
    return true;
  });
  return personal[0] || parts[0] || clean;
}

/** Unidades em mãos por revendedora (só kit aberto e revendedora ativa). */
function resellerHoldings() {
  return db.prepare(`
    SELECT ki.product_id, k.reseller_id, r.name AS reseller_name, r.phone AS reseller_phone,
           SUM(ki.quantity_available) AS qty
    FROM kit_items ki
    JOIN kits k ON k.id = ki.kit_id
    JOIN resellers r ON r.id = k.reseller_id
    WHERE k.status = 'entregue' AND r.status = 'ativa' AND ki.quantity_available > 0
    GROUP BY ki.product_id, k.reseller_id
    ORDER BY r.name
  `).all();
}

/** Saldo físico no estoque da empresa, por produto (mesma régua do resto do sistema:
 * soma dos movimentos, que já desconta a saída de cada kit). */
function depotQuantities() {
  const rows = db.prepare(`
    SELECT product_id, COALESCE(SUM(quantity), 0) AS qty
    FROM stock_movements GROUP BY product_id
  `).all();
  const out = {};
  for (const r of rows) out[r.product_id] = r.qty;
  return out;
}

function publicPayload({ ignoreDisabled = false } = {}) {
  ensureTable();
  const settings = getSettings();
  const brand = db.prepare('SELECT trade_name, legal_name FROM company_settings WHERE id = 1').get();
  const brandName = (brand && (brand.trade_name || brand.legal_name)) || 'SexS';
  // Desligado = sem dados na resposta, não só escondido na página. O painel da CEO pede
  // ignoreDisabled para continuar mostrando as contas do que estaria no ar.
  if (settings.enabled !== 1 && !ignoreDisabled) {
    return { ok: true, enabled: false, generated_at: new Date().toISOString(), brand: brandName };
  }

  const depot = depotQuantities();
  const holdings = resellerHoldings();
  const byProduct = new Map();
  for (const h of holdings) {
    if (!byProduct.has(h.product_id)) byProduct.set(h.product_id, []);
    byProduct.get(h.product_id).push(h);
  }

  const products = db.prepare(`
    SELECT p.id, p.name, p.category, p.description, p.photo_url
    FROM products p
    WHERE p.active = 1
    ORDER BY p.category IS NULL, p.category, p.name
  `).all();

  const items = products.map((p) => {
    const holders = [];
    for (const h of (byProduct.get(p.id) || [])) {
      holders.push({
        kind: 'revendedora',
        reseller_id: h.reseller_id,
        name: h.reseller_name,
        greeting: greetingName(h.reseller_name),
        whatsapp: normalizeWhatsapp(h.reseller_phone),
      });
    }
    if ((depot[p.id] || 0) > 0) {
      holders.push({
        kind: 'estoque', name: settings.contact_label, greeting: greetingName(settings.contact_label),
        whatsapp: normalizeWhatsapp(settings.contact_whatsapp),
      });
    }
    return {
      id: p.id,
      name: p.name,
      category: p.category || 'Outros',
      description: (p.description || '').trim(),
      photo_url: (p.photo_url || '').trim(),
      available: holders.length > 0,
      holders,
    };
  });

  // Revendedoras ativas. As que têm produto pronto aparecem na vitrine de contatos; as
  // demais continuam elegíveis para receber encomenda.
  const resellers = db.prepare(`
    SELECT r.id, r.name, r.phone FROM resellers r
    WHERE r.status = 'ativa'
    ORDER BY r.name
  `).all().map((r) => {
    const count = items.filter((it) => it.holders.some((h) => h.kind === 'revendedora' && h.reseller_id === r.id)).length;
    return { id: r.id, name: r.name, greeting: greetingName(r.name), whatsapp: normalizeWhatsapp(r.phone), products_available: count };
  });

  return {
    ok: true,
    enabled: settings.enabled === 1,
    generated_at: new Date().toISOString(),
    brand: brandName,
    contact: {
      label: settings.contact_label,
      greeting: greetingName(settings.contact_label),
      whatsapp: normalizeWhatsapp(settings.contact_whatsapp),
      work_with_us_message: settings.work_with_us_message,
    },
    categories: [...new Set(items.map((i) => i.category))],
    resellers,
    products: items,
  };
}

module.exports = { getSettings, saveSettings, publicPayload, normalizeWhatsapp, greetingName };
