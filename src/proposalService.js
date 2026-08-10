// Serviço de propostas — motor genérico do fluxo estruturado da Seção 7:
// intenção -> entidades -> dados ausentes -> ação proposta -> impacto calculado ->
// risco -> aprovação -> execução determinística -> auditoria.
//
// Este arquivo NÃO conhece os detalhes de compra de estoque, contratação de
// revendedora, etc. Cada módulo de negócio se registra aqui (registerMessageHandler /
// registerExecutor). Isso evita que o motor cresça acoplado a cada novo tipo de
// proposta — extensão sem reescrever o núcleo.
const db = require('../db');
const { logAudit } = require('./audit');
const notificationService = require('./notificationService');

const fmtBRL = (cents) => (cents/100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Seção 8 ("Empresa Viva") / Seção 11 (polimento): toda vez que uma proposta é
// aprovada e executada, a CEO recebe uma notificação natural, na voz do diretor que
// executou aquilo — é o que faz o sistema parecer uma equipe trabalhando, não um
// formulário sendo salvo. Um único ponto central (aqui, não em cada módulo de
// negócio) garante que NENHUMA ação aprovada fica muda, sem precisar lembrar de
// espalhar notify() em cada arquivo novo.
function describeExecution(intent, extracted) {
  switch (intent) {
    case 'compra_estoque':
      return `Diego registrou a entrada de ${extracted.quantity} unidade(s) de "${extracted.product_name}".`;
    case 'cadastrar_produto':
      return `Diego cadastrou "${extracted.name}" no catálogo, com ${extracted.quantity} unidade(s) já em estoque.`;
    case 'contratar_revendedora':
      return `Marina cadastrou ${extracted.name} como nova revendedora.`;
    case 'contratar_revendedora_result':
      return `Revendedora cadastrada! Login: ${extracted.username} | Senha: ${extracted.password}`;
    case 'atualizar_revendedora':
      return `Marina atualizou o cadastro de ${extracted.name}.`;
    case 'desativar_revendedora':
      return `Marina desligou ${extracted.name} da empresa.`;
    case 'registrar_despesa':
      return `Renata registrou uma despesa de ${fmtBRL(extracted.amount_cents)}${extracted.description ? ` (${extracted.description})` : ''}.`;
    case 'nova_regra_precificacao':
      return `Renata ativou uma nova política de preço — comissão ${(extracted.commission_pct*100).toFixed(0)}%, multiplicador de custo ${extracted.cost_multiplier}x.`;
    case 'criar_campanha':
      return `Theo criou a campanha "${extracted.title}"${extracted.start_date ? ` (${extracted.start_date} a ${extracted.end_date || '?'})` : ''}.`;
    case 'definir_meta_vendas':
      return `Ricardo definiu a meta de ${fmtBRL(extracted.target_cents)} para ${extracted.period_label}.`;
    default:
      return null;
  }
}

function getActivePricingRule() {
  const rule = db.prepare('SELECT * FROM pricing_rules WHERE active = 1 ORDER BY version DESC LIMIT 1').get();
  if (!rule) throw new Error('Nenhuma regra de precificação ativa. Contate o administrador.');
  return rule;
}

const messageHandlers = new Map(); // thread -> ({text, userId}) => {reply, proposal}
const executors = new Map(); // intent -> (extracted, proposalId, ceoUser) => void (dentro de transação)

function registerMessageHandler(thread, fn) { messageHandlers.set(thread, fn); }
function registerExecutor(intent, fn) { executors.set(intent, fn); }

async function handleDirectorMessage({ thread, text, userId }) {
  const handler = messageHandlers.get(thread);
  if (!handler) {
    return {
      reply:
        'Ainda não implementei a interpretação de linguagem natural para este contato nesta ' +
        'entrega (veja o relatório final — próxima etapa recomendada).',
      proposal: null,
    };
  }
  // `await` funciona tanto para handlers síncronos quanto assíncronos (os que
  // consultam o AI Gateway) — nenhum handler precisa saber se a IA está em uso.
  return handler({ text, userId });
}

/** Cria uma proposta pendente e registra na auditoria. Usado pelos módulos de negócio. */
function createProposal({ rawText, intent, extracted, missingFields = [], impact = null, riskLevel, targetDirector, userId }) {
  const info = db
    .prepare(
      `INSERT INTO proposals (raw_text, intent, extracted_json, missing_fields_json, impact_json, risk_level, target_director, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(rawText, intent, JSON.stringify(extracted), JSON.stringify(missingFields), impact ? JSON.stringify(impact) : null, riskLevel, targetDirector, userId);
  const proposalId = info.lastInsertRowid;
  logAudit({ actorUserId: userId, actorLabel: 'CEO', action: 'proposal.created', entityType: 'proposal', entityId: proposalId, details: extracted });
  return getProposal(proposalId);
}

function getProposal(id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) return null;
  return {
    ...p,
    extracted: JSON.parse(p.extracted_json || '{}'),
    impact: p.impact_json ? JSON.parse(p.impact_json) : null,
    missing_fields: p.missing_fields_json ? JSON.parse(p.missing_fields_json) : [],
  };
}

function listProposals({ status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM proposals ORDER BY id DESC').all();
  return rows.map((p) => ({
    ...p,
    extracted: JSON.parse(p.extracted_json || '{}'),
    impact: p.impact_json ? JSON.parse(p.impact_json) : null,
  }));
}

/** Aprova e executa uma proposta pendente dentro de uma transação: tudo ou nada. */
function approveAndExecute(proposalId, ceoUser) {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) throw new Error('Proposta não encontrada.');
  if (proposal.status !== 'pendente') throw new Error(`Proposta já está em status "${proposal.status}".`);
  const executor = executors.get(proposal.intent);
  if (!executor) throw new Error(`Tipo de proposta "${proposal.intent}" não possui executor registrado.`);

  const extracted = JSON.parse(proposal.extracted_json);

  db.exec('BEGIN');
  try {
    const executionResult = executor(extracted, proposalId, ceoUser) || null;

    db.prepare(
      `UPDATE proposals SET status = 'executada', decided_by = ?, decided_at = datetime('now'), executed_at = datetime('now') WHERE id = ?`
    ).run(ceoUser.id, proposalId);

    db.exec('COMMIT');

    const message = describeExecution(proposal.intent, extracted);
    if (message) {
      notificationService.notify({ recipientRole: 'ceo', type: `proposal.${proposal.intent}`, message, entityType: 'proposal', entityId: proposalId });
    }

    return { ...getProposal(proposalId), execution_result: executionResult };
  } catch (err) {
    db.exec('ROLLBACK');
    db.prepare(`UPDATE proposals SET status = 'falhou', error = ? WHERE id = ?`).run(String(err.message || err), proposalId);
    logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'proposal.failed', entityType: 'proposal', entityId: proposalId, details: { error: String(err.message || err) } });
    throw err;
  }
}

function reject(proposalId, ceoUser, reason) {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId);
  if (!proposal) throw new Error('Proposta não encontrada.');
  if (proposal.status !== 'pendente') throw new Error(`Proposta já está em status "${proposal.status}".`);
  db.prepare(`UPDATE proposals SET status = 'rejeitada', decided_by = ?, decided_at = datetime('now'), error = ? WHERE id = ?`).run(
    ceoUser.id,
    reason || null,
    proposalId
  );
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'proposal.rejected', entityType: 'proposal', entityId: proposalId, details: { reason } });
  return getProposal(proposalId);
}

module.exports = {
  handleDirectorMessage, getProposal, listProposals, approveAndExecute, reject,
  getActivePricingRule, createProposal, registerMessageHandler, registerExecutor,
};
