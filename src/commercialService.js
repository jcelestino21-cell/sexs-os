// Ricardo — Diretor Comercial (Seção 3): vendas, metas, desempenho, ticket médio.
// Nunca acessa documentos pessoais das revendedoras (CPF, endereço) — só desempenho.
const db = require('../db');
const proposalService = require('./proposalService');
const { logAudit } = require('./audit');
const { aiAssist } = require('./events');

const GOAL_REGEX = /defin[ae]\s+a\s+meta\s+(do\s+m[êe]s\s+)?(de\s+|em\s+)?r?\$?\s?(?<amount>[\d.,]+)/i;

function currentPeriodLabel() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
}

function performanceSnapshot() {
  const confirmedSales = db.prepare(`
    SELECT ks.quantity, ks.unit_price_cents FROM kit_sales ks WHERE ks.status = 'confirmada'
  `).all();
  const totalRevenue = confirmedSales.reduce((s, r) => s + r.quantity * r.unit_price_cents, 0);
  const totalUnits = confirmedSales.reduce((s, r) => s + r.quantity, 0);
  const avgTicketCents = confirmedSales.length > 0 ? Math.round(totalRevenue / confirmedSales.length) : 0;

  const goal = db.prepare('SELECT * FROM sales_goals WHERE period_label = ? ORDER BY id DESC LIMIT 1').get(currentPeriodLabel());

  const rankingRows = db.prepare(`
    SELECT r.id, r.name, COALESCE(SUM(ks.quantity*ks.unit_price_cents),0) as total
    FROM resellers r
    LEFT JOIN kits k ON k.reseller_id = r.id
    LEFT JOIN kit_items ki ON ki.kit_id = k.id
    LEFT JOIN kit_sales ks ON ks.kit_item_id = ki.id AND ks.status = 'confirmada'
    GROUP BY r.id ORDER BY total DESC
  `).all();

  // Só conta como "inativa" quem já recebeu ao menos um kit entregue (ou além) e ainda
  // assim está com zero venda confirmada — nunca uma revendedora que simplesmente
  // ainda não teve nenhum kit sugerido (isso é normal, não é um problema).
  const deliveredResellerIds = new Set(
    db.prepare(`SELECT DISTINCT reseller_id FROM kits WHERE status IN ('entregue','aguardando_fechamento','encerrado')`).all().map(r => r.reseller_id)
  );
  const inactive = rankingRows.filter((r) => r.total === 0 && deliveredResellerIds.has(r.id)).map((r) => r.name);

  return { totalRevenue, totalUnits, avgTicketCents, goal, ranking: rankingRows, inactiveResellers: inactive };
}

function fmt(cents) { return (cents/100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }

function parseGoalMessage(text) {
  const match = text.match(GOAL_REGEX);
  let amount_cents = null;
  if (match) {
    const raw = match.groups.amount.replace(/\./g, '').replace(',', '.');
    const val = Math.round(parseFloat(raw) * 100);
    if (!Number.isNaN(val)) amount_cents = val;
  }
  return { intent: 'definir_meta_vendas', entities: { amount_cents }, missing: amount_cents !== null ? [] : ['valor da meta'], recognized: amount_cents !== null };
}

async function parseGoalMessageSmart(text, userId) {
  const base = parseGoalMessage(text);
  const result = await aiAssist(base, {
    intent: 'definir_meta_vendas',
    userId, thread: 'ricardo',
    text,
    instruction: 'Extraia o valor da meta de vendas em reais (número, ex.: 1000 para R$ 1.000,00).',
    schemaHint: '{"amount_brl": number|null}',
    recomputeMissing: (e) => (e.amount_brl != null || e.amount_cents != null ? [] : ['valor da meta']),
  });
  if (result.entities && result.entities.amount_brl != null && result.entities.amount_cents == null) {
    result.entities.amount_cents = Math.round(result.entities.amount_brl * 100);
  }
  return result;
}

async function handleRicardoMessage({ text, userId }) {
  const parsed = await parseGoalMessageSmart(text, userId);
  if (parsed.recognized && parsed.entities.amount_cents != null) {
    const extracted = { period_label: currentPeriodLabel(), target_cents: parsed.entities.amount_cents };
    const proposal = proposalService.createProposal({
      rawText: text, intent: 'definir_meta_vendas', extracted, riskLevel: 'baixo', targetDirector: 'ricardo', userId,
    });
    return { reply: `Entendi: meta de ${fmt(extracted.target_cents)} para ${extracted.period_label}. Aprova ou rejeita?`, proposal };
  }

  const snap = performanceSnapshot();
  const goalLine = snap.goal
    ? `Meta de ${currentPeriodLabel()}: ${fmt(snap.goal.target_cents)} — realizado ${fmt(snap.totalRevenue)} (${snap.totalRevenue >= snap.goal.target_cents ? 'batida ✅' : 'ainda não batida'}).`
    : `Sem meta definida para ${currentPeriodLabel()}. Diga "defina a meta do mês em R$ [valor]" se quiser.`;
  const inactiveLine = snap.inactiveResellers.length > 0
    ? `Sem nenhuma venda confirmada ainda: ${snap.inactiveResellers.join(', ')}.`
    : 'Todas as revendedoras com kit já têm ao menos uma venda confirmada.';

  return {
    reply: `Vendas confirmadas até agora: ${fmt(snap.totalRevenue)} em ${snap.totalUnits} unidades (ticket médio ${fmt(snap.avgTicketCents)} por venda informada).\n${goalLine}\n${inactiveLine}`,
    proposal: null,
  };
}

function executeDefinirMetaVendas(extracted, proposalId, ceoUser) {
  const info = db.prepare('INSERT INTO sales_goals (period_label, target_cents, created_by) VALUES (?,?,?)').run(extracted.period_label, extracted.target_cents, ceoUser.id);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'sales_goal.set', entityType: 'sales_goal', entityId: info.lastInsertRowid, details: extracted });
}

proposalService.registerMessageHandler('ricardo', handleRicardoMessage);
proposalService.registerExecutor('definir_meta_vendas', executeDefinirMetaVendas);

module.exports = { performanceSnapshot };
