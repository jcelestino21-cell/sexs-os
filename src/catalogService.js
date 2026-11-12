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
const crypto = require('crypto');
const db = require('../db');
const { logAudit } = require('./audit');

const SETTINGS_SQL = `CREATE TABLE IF NOT EXISTS catalog_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  contact_label TEXT NOT NULL DEFAULT 'SexS',
  contact_whatsapp TEXT,
  contact_message TEXT,
  work_with_us_message TEXT,
  censored_categories TEXT NOT NULL DEFAULT 'Próteses',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/* Censura da vitrine: foto de objeto sexual explícito (prótese, plug, consolador) não
 * aparece para a cliente — no lugar entra o símbolo de censura. O card continua lá, com
 * nome e descrição, e a foto fica fora do payload (não é só escondida no CSS).
 * A lista de categorias é configurável; o resto da regra vem do nome do produto, para
 * pegar plug vendido em categoria genérica e, ao contrário, NÃO pegar consumível
 * (gel, creme, lubrificante, perfume) cadastrado na categoria 'Anal'. */
const OBJETO_RX = /pr[óo]tese|consolador|\bdildo\b|\bplug\b|p[êe]nis de borracha|dilata[çc]ao|an[áa]l expand/i;
/* Consomível = não é objeto, mesmo cadastrado numa categoria censurada. Só valem as
 * palavras do produto em si (gel, creme, lubrificante, perfume…): sabor no nome
 * ("Pênis Aromático - Menta") não livra ninguém da censura. */
const CONSUMIVEL_RX = /\bgel\b|\bg[ée]is\b|creme|lubrific|perfume|sabonete|spray|[óo]leo|len[çc]o|comest[íi]vel|excitante|hidratante|massagem|pomada|serum/i;

const DEFAULTS = {
  enabled: 1,
  contact_label: 'SexS',
  contact_whatsapp: null,
  contact_message: null,
  work_with_us_message: 'Tenho interesse em fazer parte da equipe',
  censored_categories: 'Próteses',
};

let tableReady = false;
/** A tabela é criada sob demanda (mesmo padrão das demais rotas que precisam de uma
 * estrutura nova sem migração versionada): leitura nunca escreve. */
function ensureTable() {
  if (!tableReady) {
    db.exec(SETTINGS_SQL);
    const cols = db.prepare('PRAGMA table_info(catalog_settings)').all().map((c) => c.name);
    if (!cols.includes('censored_categories')) {
      db.prepare("ALTER TABLE catalog_settings ADD COLUMN censored_categories TEXT NOT NULL DEFAULT 'Próteses'").run();
    }
    tableReady = true;
  }
}

function semAcento(txt) {
  return String(txt || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function listaCensurada(settings) {
  return String(settings.censored_categories || '').split(',').map((x) => semAcento(x)).filter(Boolean);
}

/** Verdadeiro quando a foto não pode aparecer na vitrine. */
function fotoCensurada(p, settings) {
  const nome = semAcento(p.name);
  if (CONSUMIVEL_RX.test(nome)) return false; // gel/creme com nome de 'Anal' não é objeto
  if (listaCensurada(settings).includes(semAcento(p.category))) return true;
  return OBJETO_RX.test(nome);
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
    censored_categories: data.censored_categories === undefined
      ? current.censored_categories
      : (String(data.censored_categories || '').split(',').map((x) => x.trim()).filter(Boolean).join(', ').slice(0, 200) || ''),
    work_with_us_message: data.work_with_us_message === undefined ? current.work_with_us_message : (String(data.work_with_us_message).trim().slice(0, 200) || DEFAULTS.work_with_us_message),
  };

  db.prepare(
    `UPDATE catalog_settings SET enabled = ?, contact_label = ?, contact_whatsapp = ?, work_with_us_message = ?,
       censored_categories = ?, updated_by = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(next.enabled, next.contact_label, next.contact_whatsapp, next.work_with_us_message,
        next.censored_categories, actorUser ? actorUser.id : null);
  logAudit({
    actorUserId: actorUser ? actorUser.id : null, actorLabel: 'CEO', action: 'catalog.settings_updated',
    entityType: 'catalog_settings', entityId: 1,
    details: { enabled: next.enabled, contact_label: next.contact_label, whatsapp_set: !!next.contact_whatsapp,
               censored_categories: next.censored_categories },
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

/** Assinatura do que a vitrine mostra, usada como ETag no GET público.
 *
 * Por que existe: a página fica aberta no celular da cliente enquanto o sistema muda
 * (venda lançada, unidade devolvida no fechamento de um kit, produto ativado). Ela
 * re-pergunta a cada poucos segundos; se a assinatura for a mesma, a rota devolve 304
 * sem corpo e nada é baixado nem reprocessado.
 *
 * Como é montada, e por que assim:
 *  - nas tabelas que podem crescer (movimentos, itens de kit, vendas) usam-se agregados:
 *    MAX(id) pega insert/delete e SUM pega quantidade que muda;
 *  - no que é texto mostrado (nome, categoria, descrição, foto, telefone de contato,
 *    rótulo do estoque, nome da empresa) hash do conteúdo inteiro — 71 produtos + 8
 *    revendedoras, uns poucos KB. Só comprimento não bastava: trocar
 *    "(16) 99111-2222" por "(16) 99888-7766" mantém o tamanho e a cliente ficaria com o
 *    número velho para sempre; um produto renomeado com o mesmo número de letras, idem.
 *  - o que a cliente NÃO vê (preço, custo, comissão, margem, saldo, endereço) fica fora
 *    de propósito: mexer nisso não pode obrigar toda vitrine a baixar o catálogo de novo.
 *  - só produto ATIVO e revendedora ATIVA entram na conta.
 */
function catalogVersion() {
  ensureTable();
  const agg = db.prepare(`
    SELECT
      (SELECT COALESCE(MAX(sm.id), 0) FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id AND p.active = 1) AS mv_max,
      (SELECT COALESCE(SUM(sm.quantity), 0) FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id AND p.active = 1) AS mv_sum,
      (SELECT COALESCE(MAX(ki.id), 0) FROM kit_items ki
         JOIN kits k ON k.id = ki.kit_id AND k.status = 'entregue'
         JOIN resellers r ON r.id = k.reseller_id AND r.status = 'ativa') AS ki_max,
      (SELECT COALESCE(SUM(ki.quantity_available), 0) FROM kit_items ki
         JOIN kits k ON k.id = ki.kit_id AND k.status = 'entregue'
         JOIN resellers r ON r.id = k.reseller_id AND r.status = 'ativa') AS ki_in_hand,
      (SELECT COALESCE(MAX(ks.id), 0) FROM kit_sales ks
         JOIN kit_items ki ON ki.id = ks.kit_item_id
         JOIN kits k ON k.id = ki.kit_id AND k.status = 'entregue'
         JOIN resellers r ON r.id = k.reseller_id AND r.status = 'ativa') AS ks_max,
      -- os "queridinhos" saem do mesmo histórico, mas contam as vendas informadas
      -- também; sem isto a faixa poderia trocar na tela da cliente sem o ETag mudar
      (SELECT COALESCE(SUM(kqs.quantity), 0) FROM kit_sales kqs
         JOIN kit_items ki ON ki.id = kqs.kit_item_id
         JOIN products p ON p.id = ki.product_id AND p.active = 1
        WHERE kqs.status IN ('informada', 'confirmada')) AS hot_units,
      (SELECT COALESCE(MAX(kqs.id), 0) FROM kit_sales kqs
        WHERE kqs.status IN ('informada', 'confirmada')) AS hot_max
  `).get();
  const shown = db.prepare(`
    SELECT 'P' || id || '|' || name || '|' || COALESCE(category, '') || '|' || COALESCE(description, '')
                || '|' || COALESCE(photo_url, '') AS t
      FROM products WHERE active = 1 ORDER BY id
  `).all().map((r) => r.t).join('\n');
  const contatos = db.prepare(`
    SELECT 'R' || id || '|' || name || '|' || COALESCE(phone, '') AS t
      FROM resellers WHERE status = 'ativa' ORDER BY id
  `).all().map((r) => r.t).join('\n');
  const st = db.prepare(`
    SELECT enabled || '|' || COALESCE(contact_label, '') || '|' || COALESCE(contact_whatsapp, '')
                  || '|' || COALESCE(work_with_us_message, '')
                  || '|' || COALESCE(censored_categories, '') AS t
      FROM catalog_settings WHERE id = 1
  `).get();
  const marca = db.prepare("SELECT COALESCE(trade_name, '') || '|' || COALESCE(legal_name, '') AS t FROM company_settings WHERE id = 1").get();
  // O dia entra na conta porque a janela de 60 dias vira sozinha: sem isto, uma cliente
  // com a página aberta por dias mostraria um ranking de ontem para sempre.
  const bruto = [Object.keys(agg).map((k) => `${k}=${agg[k]}`).join('.'), shown, contatos, (st && st.t) || '', (marca && marca.t) || '',
                 new Date().toISOString().slice(0, 10)].join('#');
  return crypto.createHash('sha256').update(bruto).digest('hex').slice(0, 32);
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

/* ---------------------------------------------------------------------------
 * "Queridinhos do momento" — a vitrine mostra os 5 produtos que MAIS SAÍRAM.
 *
 * De onde vem o número: do histórico de vendas das revendedoras, não de palpite.
 * Cada venda registrada num kit (kit_sales) conta as unidades daquele produto:
 *  - status 'informada' (a revendedora lançou) e 'confirmada' (a CEO conferiu)
 *    entram — é isso que dá a sensação de "atualiza sozinho conforme sai";
 *  - 'rejeitada' fica de fora de propósito: é exatamente como o estorno de venda
 *    é registrado (o histórico é mantido para auditoria, mas para de contar no
 *    ranking e no financeiro).
 * Unidades, não reais: senão um produto caro aparece como "queridinho" só porque
 * custa mais.
 *
 * Janela: os últimos QUERIDOS_DIAS dias — "do momento" quer dizer isso. Se a
 * janela vier vazia (loja parada, sistema recém-começado), o ranking usa o
 * histórico todo em vez de sumir com a seção; se ainda assim não houver venda
 * nenhuma, a vitrine simplesmente não mostra a faixa.
 *
 * Desempate: quantas revendedoras diferentes venderam (querida por várias vale
 * mais que 4 unidades na mão de uma só) e depois o nome, para a ordem ser
 * estável entre duas atualizações.
 * ------------------------------------------------------------------------- */
const QUERIDOS_DIAS = 60;
const QUERIDOS_MAX = 5;

function queridinhosDoMomento() {
  const consulta = `
    SELECT ki.product_id AS product_id,
           SUM(ks.quantity) AS units,
           COUNT(DISTINCT k.reseller_id) AS fans,
           MAX(ks.created_at) AS last_at
      FROM kit_sales ks
      JOIN kit_items ki ON ki.id = ks.kit_item_id
      JOIN kits k ON k.id = ki.kit_id
      JOIN products p ON p.id = ki.product_id AND p.active = 1
     WHERE ks.status IN ('informada', 'confirmada')
       AND (? IS NULL OR ks.created_at >= datetime('now', ?))
     GROUP BY ki.product_id
     ORDER BY units DESC, fans DESC, p.name
     LIMIT ?
  `;
  let itens = db.prepare(consulta).all(`-${QUERIDOS_DIAS} day`, `-${QUERIDOS_DIAS} day`, QUERIDOS_MAX);
  let dias = QUERIDOS_DIAS;
  if (!itens.length) {
    dias = null;
    itens = db.prepare(consulta).all(null, null, QUERIDOS_MAX);
  }
  return { dias, itens };
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

  const hot = queridinhosDoMomento();
  const hotRank = new Map(hot.itens.map((x, i) => [x.product_id, i + 1]));

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
      photo_url: fotoCensurada(p, settings) ? '' : (p.photo_url || '').trim(),
      censored: fotoCensurada(p, settings),
      // Só os mais vendidos trazem isto; os demais nem ganham a chave (payload enxuto).
      ...(() => {
        const rank = hotRank.get(p.id);
        if (!rank) return {};
        const h = hot.itens[rank - 1];
        return { hot: { rank, units: h.units, fans: h.fans, last_at: h.last_at } };
      })(),
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
    trending: { days: hot.dias, max: QUERIDOS_MAX },
    categories: [...new Set(items.map((i) => i.category))],
    resellers,
    products: items,
  };
}

module.exports = { getSettings, saveSettings, publicPayload, catalogVersion, normalizeWhatsapp, greetingName, queridinhosDoMomento };
