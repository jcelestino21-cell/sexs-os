// Theo — Diretor de Marketing (Seção 3): campanhas, conteúdo, calendário comercial.
// NUNCA afirma que algo "está em alta" sem evidência atual (Seção "Empresa ativa"),
// e este ambiente não tem acesso a fontes externas — Theo declara essa limitação em
// vez de inventar pesquisa de tendência.
const db = require('../db');
const proposalService = require('./proposalService');
const { logAudit } = require('./audit');
const { aiAssist } = require('./events');

const CAMPAIGN_REGEX = /(?:crie?|fazer|faca|montar|preparar|organizar|quero(?:\s+fazer)?(?:\s+uma)?)\s+(?:uma\s+)?campanha\s+(?:de\s+)?(?<title>.+?)(?:\s+de\s+(?<start>\d{1,2}\/\d{1,2})\s+a\s+(?<end>\d{1,2}\/\d{1,2}))?$/i;
const TREND_QUERY_REGEX = /tend[êe]ncia|em alta|o que est[áa] bombando|pesquis[ae]/i;

function parseCampaignMessage(text) {
  const match = text.trim().replace(/\.$/, '').match(CAMPAIGN_REGEX);
  const entities = { title: match?.groups?.title?.trim() || null, start_date: match?.groups?.start || null, end_date: match?.groups?.end || null };
  return { intent: 'criar_campanha', entities, missing: entities.title ? [] : ['nome da campanha'], recognized: !!entities.title };
}

async function parseCampaignMessageSmart(text, userId) {
  const base = parseCampaignMessage(text);
  return aiAssist(base, {
    intent: 'criar_campanha',
    userId, thread: 'theo',
    text,
    instruction: 'Extraia o nome da campanha e, se houver, as datas de início e fim no formato dd/mm.',
    schemaHint: '{"title": string|null, "start_date": string|null, "end_date": string|null}',
    recomputeMissing: (e) => (e.title ? [] : ['nome da campanha']),
  });
}

async function handleTheoMessage({ text, userId }) {
  if (TREND_QUERY_REGEX.test(text)) {
    return {
      reply:
        'Não tenho acesso a fontes externas de pesquisa de tendência neste ambiente — não vou inventar que algo "está em alta" sem evidência real. ' +
        'Posso, sim, organizar o calendário de campanhas com o que você já sabe do seu público. Quer criar uma campanha? Diga: "Crie uma campanha de [nome], de [dd/mm] a [dd/mm]."',
      proposal: null,
    };
  }

  const parsed = await parseCampaignMessageSmart(text, userId);
  if (!parsed.recognized) {
    const upcoming = db.prepare(`SELECT * FROM marketing_campaigns WHERE status != 'encerrada' ORDER BY start_date`).all();
    return {
      reply: upcoming.length > 0
        ? `Campanhas ativas/planejadas:\n${upcoming.map(c => `• ${c.title}${c.start_date ? ` (${c.start_date}${c.end_date ? ' a '+c.end_date : ''})` : ''} — ${c.status}`).join('\n')}`
        : 'Nenhuma campanha cadastrada ainda. Diga: "Crie uma campanha de [nome], de [dd/mm] a [dd/mm]."',
      proposal: null,
    };
  }

  const extracted = parsed.entities;
  const proposal = proposalService.createProposal({
    rawText: text, intent: 'criar_campanha', extracted, riskLevel: 'baixo', targetDirector: 'theo', userId,
  });
  return {
    reply: `Entendi: campanha "${extracted.title}"${extracted.start_date ? ` de ${extracted.start_date} a ${extracted.end_date||'?'}` : ' (sem datas definidas)'}. Aprova ou rejeita?`,
    proposal,
  };
}

function executeCriarCampanha(extracted, proposalId, ceoUser) {
  const info = db
    .prepare('INSERT INTO marketing_campaigns (title, start_date, end_date, created_by) VALUES (?,?,?,?)')
    .run(extracted.title, extracted.start_date, extracted.end_date, ceoUser.id);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'campaign.created', entityType: 'marketing_campaign', entityId: info.lastInsertRowid, details: extracted });
}

function listCampaigns() {
  return db.prepare('SELECT * FROM marketing_campaigns ORDER BY id DESC').all();
}

proposalService.registerMessageHandler('theo', handleTheoMessage);
proposalService.registerExecutor('criar_campanha', executeCriarCampanha);

module.exports = { listCampaigns };
