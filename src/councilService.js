// Conselho Executivo (Seção 5 e testes de aceitação #11/#24): fluxo diferente de
// conversa individual — não é "responder em sequência repetitiva" (proibição
// explícita), é uma síntese cruzada + decisões/tarefas rastreáveis, separadas do
// histórico solto de chat (Seção "Memória empresarial": "histórico de chat sozinho
// não é memória empresarial suficiente").
// FASE 10.5 — CORREÇÃO: require de resellerService movido para o topo do arquivo,
// em vez de ser feito inline dentro de gatherFacts().
const db = require('../db');
const { logAudit } = require('./audit');
const dashboardService = require('./dashboardService');
const financeService = require('./financeService');
const commercialService = require('./commercialService');
const advisorService = require('./advisorService');
const marketingService = require('./marketingService');
const resellerService = require('./resellerService');
const aiGateway = require('./aiGateway');

/** Coleta os fatos reais de cada área — usados tanto pela síntese simples (convene)
 * quanto pelo debate do conselho (runDebate). Nenhum dado é inventado aqui; tudo vem
 * dos módulos de negócio já existentes. */
function gatherFacts(topic) {
  const d = dashboardService.getDashboard();
  const financial = financeService.financialSummary();
  const perf = commercialService.performanceSnapshot();
  const advisory = advisorService.synthesize();
  const campaigns = marketingService.listCampaigns().filter((c) => c.status !== 'encerrada');
  const resellers = resellerService.listResellers();
  const activeResellers = resellers.filter((r) => r.status === 'ativa').length;
  const pendingDocsResellers = resellers.filter((r) => r.status === 'pendente_documentos').length;
  const isHiringTopic = topic && /contrata|revendedora|rh|admiss/i.test(topic);
  const marginLow = financial.faturamento_confirmado_cents > 0 &&
    (financial.lucro_liquido_cents / financial.faturamento_confirmado_cents) < 0.15;
  return {
    d, financial, perf, advisory, campaigns, resellers, activeResellers, pendingDocsResellers,
    isHiringTopic, marginLow, lowStock: d.low_stock_products,
  };
}

function convene(topic) {
  const f = gatherFacts(topic);
  const fmt = (c) => (c/100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });

  return {
    topic: topic || null,
    convened_at: new Date().toLocaleString('pt-BR'),
    sections: [
      { director: 'Diego (Operações)', summary: f.lowStock.length > 0
          ? `${f.lowStock.length} produto(s) com estoque baixo: ${f.lowStock.map(p=>p.name).join(', ')}.`
          : 'Estoque dentro do esperado, sem alertas críticos.' },
      { director: 'Marina (RH)', summary: `${f.activeResellers} revendedora(s) ativa(s) de ${f.resellers.length} cadastrada(s)${f.pendingDocsResellers > 0 ? `, ${f.pendingDocsResellers} com documentação pendente` : ''}.${f.isHiringTopic ? ' Pauta de contratação: fale comigo diretamente na Central para abrir uma nova vaga/cadastro.' : ''}` },
      { director: 'Renata (Financeiro)', summary: `Faturamento confirmado ${fmt(f.financial.faturamento_confirmado_cents)}, CMV ${fmt(f.financial.custo_mercadorias_vendidas_cents)}, despesas ${fmt(f.financial.despesas_operacionais_cents)}, lucro líquido ${fmt(f.financial.lucro_liquido_cents)}.` },
      { director: 'Ricardo (Comercial)', summary: `${fmt(f.perf.totalRevenue)} vendidos em ${f.perf.totalUnits} unidades confirmadas.${f.perf.inactiveResellers.length ? ` ${f.perf.inactiveResellers.length} revendedora(s) sem venda ainda.` : ''}` },
      { director: 'Theo (Marketing)', summary: f.campaigns.length > 0 ? `${f.campaigns.length} campanha(s) planejada(s)/ativa(s): ${f.campaigns.map(c=>c.title).join(', ')}.` : 'Nenhuma campanha ativa no momento.' },
      { director: 'Arthur (Conselheiro)', summary: f.advisory.summary },
    ],
  };
}

// ---------------------------------------------------------------------------------
// Debate real do Conselho Executivo (Seção 6). O briefing acima ("convene") continua
// existindo — cada área falando uma vez, com fatos — mas o documento final pede mais:
// os diretores precisam reagir uns aos outros (concordar, discordar, levantar risco).
//
// Com IA configurada: pedimos à IA para simular a rodada de debate, mas SOMENTE com
// base nos fatos já coletados acima — ela nunca inventa números, só interpreta e
// faz os diretores reagirem entre si a partir do que já é real.
//
// Sem IA: aplicamos um pequeno conjunto de regras determinísticas de reação cruzada
// (ex.: campanha ativa + estoque baixo do mesmo tipo de produto = alerta do Diego
// pro Theo). Não é uma IA "pensando", mas já é debate de verdade — um diretor reage
// ao dado real de outro — em vez de seis falas isoladas, que era o problema.
// ---------------------------------------------------------------------------------
function deterministicDebate(f) {
  const turns = [];
  const risks = [];
  const divergences = [];

  turns.push({ speaker: 'Diego', type: 'abertura', message:
    f.lowStock.length > 0
      ? `Temos ${f.lowStock.length} produto(s) com estoque baixo: ${f.lowStock.map(p=>p.name).join(', ')}.`
      : 'Estoque está dentro do esperado, sem ruptura à vista.' });

  if (f.campaigns.length > 0) {
    const overlapsLowStock = f.lowStock.length > 0;
    turns.push({ speaker: 'Theo', type: overlapsLowStock ? 'alerta_risco' : 'complementa', message:
      overlapsLowStock
        ? `Temos ${f.campaigns.length} campanha(s) ativa(s) (${f.campaigns.map(c=>c.title).join(', ')}) — se elas empurrarem demanda justo pros produtos que o Diego citou, a ruptura piora. Vale alinhar antes de divulgar mais.`
        : `${f.campaigns.length} campanha(s) rodando (${f.campaigns.map(c=>c.title).join(', ')}) — estoque está tranquilo pra sustentar, sem risco por esse lado.` });
    if (overlapsLowStock) risks.push('Campanha ativa pode agravar ruptura de estoque em produtos já críticos.');
  } else {
    turns.push({ speaker: 'Theo', type: 'observacao', message: 'Nenhuma campanha ativa agora — sem interferência no estoque por esse lado.' });
  }

  turns.push({ speaker: 'Renata', type: f.marginLow ? 'alerta_risco' : 'complementa', message:
    f.marginLow
      ? 'A margem líquida está abaixo de 15% do faturamento — antes de qualquer campanha nova ou desconto, precisamos revisar preço ou custo.'
      : 'Margem líquida saudável no momento — dá espaço pra investir em campanha sem pressão imediata no caixa.' });
  if (f.marginLow && f.campaigns.length > 0) {
    divergences.push('Theo quer sustentar campanhas ativas; Renata alerta que a margem atual não suporta desconto adicional sem revisão de preço.');
  }

  turns.push({ speaker: 'Ricardo', type: f.perf.inactiveResellers.length > 0 ? 'questiona' : 'complementa', message:
    f.perf.inactiveResellers.length > 0
      ? `${f.perf.inactiveResellers.length} revendedora(s) ainda sem nenhuma venda confirmada. Antes de abrir vaga nova, será que não vale focar em ativar quem já está no time?`
      : `Time de revendedoras vendendo bem — ${(f.perf.totalRevenue/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} confirmados.` });
  if (f.isHiringTopic && f.perf.inactiveResellers.length > 0) {
    divergences.push('Marina está pronta para abrir nova contratação; Ricardo questiona se não é melhor ativar revendedoras já cadastradas sem venda antes de crescer o time.');
  }

  turns.push({ speaker: 'Marina', type: 'complementa', message:
    `${f.activeResellers} revendedora(s) ativa(s) de ${f.resellers.length} cadastrada(s)${f.pendingDocsResellers > 0 ? `, ${f.pendingDocsResellers} com documentação pendente — posso resolver isso ainda essa semana` : ''}.` });

  turns.push({ speaker: 'Arthur', type: 'sintese', message: f.advisory.summary });

  return {
    turns,
    consensus: turns.filter((t) => t.type === 'complementa').length >= 2
      ? 'Os números operacionais e comerciais estão consistentes — nenhuma área vê motivo pra travar a operação no curto prazo.'
      : 'Consenso parcial — leia os riscos e divergências abaixo antes de decidir.',
    divergences,
    risks,
    recommended_plan: risks.length > 0
      ? 'Resolver os riscos levantados (estoque x campanha, ou margem x desconto) antes de qualquer decisão nova de investimento.'
      : (divergences.length > 0
          ? 'Decisão fica com você — o conselho está dividido; peça mais detalhes ao diretor que discorda antes de bater o martelo.'
          : 'Time alinhado — pode seguir com o que já está em andamento sem bloqueios internos.'),
    source: 'offline',
  };
}

async function aiDebate(f, topic) {
  const fmt = (c) => (c/100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  const factsBlock = [
    `Estoque: ${f.lowStock.length > 0 ? `baixo em ${f.lowStock.map(p=>p.name).join(', ')}` : 'normal'}.`,
    `Financeiro: faturamento ${fmt(f.financial.faturamento_confirmado_cents)}, CMV ${fmt(f.financial.custo_mercadorias_vendidas_cents)}, despesas ${fmt(f.financial.despesas_operacionais_cents)}, lucro líquido ${fmt(f.financial.lucro_liquido_cents)}.`,
    `Comercial: ${fmt(f.perf.totalRevenue)} em ${f.perf.totalUnits} unidades; ${f.perf.inactiveResellers.length} revendedora(s) sem venda.`,
    `Marketing: ${f.campaigns.length > 0 ? f.campaigns.map(c=>c.title).join(', ') : 'nenhuma campanha ativa'}.`,
    `RH: ${f.activeResellers} ativa(s) de ${f.resellers.length} cadastrada(s), ${f.pendingDocsResellers} com documentação pendente.`,
    `Leitura estratégica (Arthur): ${f.advisory.summary}`,
  ].join('\n');

  const data = await aiGateway.extractJSON({
    system:
      'Você simula uma reunião de conselho executivo entre 6 diretores de uma empresa (Diego/Operações, ' +
      'Marina/RH, Renata/Financeiro, Ricardo/Comercial, Theo/Marketing, Arthur/Conselheiro Estratégico). ' +
      'Use SOMENTE os fatos fornecidos — nunca invente números. Os diretores devem reagir uns aos outros de ' +
      'verdade: concordar, discordar, questionar, complementar ou levantar risco — nunca falas isoladas e ' +
      'genéricas. Seja específico e curto em cada fala (1-2 frases).',
    instruction:
      `Tema da reunião: ${topic || 'panorama geral da empresa'}\n\nFatos reais disponíveis:\n${factsBlock}\n\n` +
      'Gere de 6 a 10 falas de debate real entre os diretores, terminando com o resumo executivo da Ana.',
    text: topic || 'panorama geral da empresa',
    schemaHint:
      '{"turns": [{"speaker": string, "type": "concorda"|"discorda"|"questiona"|"complementa"|"alerta_risco"|"sintese", "message": string}], ' +
      '"consensus": string, "divergences": [string], "risks": [string], "recommended_plan": string}',
  });
  if (!data || !Array.isArray(data.turns) || data.turns.length === 0) return null;
  return { ...data, source: 'ai' };
}

/** Convoca o conselho com debate real entre os diretores (Seção 6). Tenta IA primeiro
 * (quando configurada); cai no debate determinístico de reação cruzada se não houver
 * IA ou se ela falhar — nunca volta a ser "seis falas isoladas". */
async function runDebate({ topic, ceoUser }) {
  const briefing = convene(topic);
  const f = gatherFacts(topic);

  let debate = aiGateway.isAvailable() ? await aiDebate(f, topic) : null;
  if (!debate) debate = deterministicDebate(f);

  // Registra a reunião como uma conversa própria (thread 'conselho') — assim ela
  // também vira parte da memória da empresa, não só um resultado descartável na tela.
  if (ceoUser) {
    const transcript = debate.turns.map((t) => `${t.speaker}: ${t.message}`).join('\n');
    db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(
      ceoUser.id, 'conselho', 'ceo', topic ? `Convocação: ${topic}` : 'Convocação: panorama geral'
    );
    db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(
      ceoUser.id, 'conselho', 'agente',
      `${transcript}\n\nResumo da Ana — consenso: ${debate.consensus} | plano recomendado: ${debate.recommended_plan}`
    );
    logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'council.debate_convened', entityType: 'council_debate', entityId: null, details: { topic, source: debate.source } });
  }

  return { ...briefing, debate: debate.turns, executive_summary: {
    consensus: debate.consensus, divergences: debate.divergences, risks: debate.risks, recommended_plan: debate.recommended_plan,
  } };
}

function createDecision({ topic, description, assignedTo, dueDate, ceoUser }) {
  const info = db
    .prepare('INSERT INTO council_decisions (topic, description, assigned_to, due_date, created_by) VALUES (?,?,?,?,?)')
    .run(topic || null, description, assignedTo || null, dueDate || null, ceoUser.id);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'council.decision_created', entityType: 'council_decision', entityId: info.lastInsertRowid, details: { description, assignedTo, dueDate } });
  return db.prepare('SELECT * FROM council_decisions WHERE id = ?').get(info.lastInsertRowid);
}

function completeDecision(id, ceoUser) {
  const row = db.prepare('SELECT * FROM council_decisions WHERE id = ?').get(id);
  if (!row) throw new Error('Decisão não encontrada.');
  if (row.status !== 'aberta') throw new Error(`Já está em status "${row.status}".`);
  db.prepare(`UPDATE council_decisions SET status = 'concluida', completed_at = datetime('now') WHERE id = ?`).run(id);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'council.decision_completed', entityType: 'council_decision', entityId: id });
  return db.prepare('SELECT * FROM council_decisions WHERE id = ?').get(id);
}

function listDecisions() {
  return db.prepare('SELECT * FROM council_decisions ORDER BY id DESC').all();
}

module.exports = { convene, runDebate, createDecision, completeDecision, listDecisions };
