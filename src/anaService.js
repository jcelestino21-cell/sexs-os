// Ana — Chefe de Gabinete e Assistente Executiva (Seção 3). NÃO toma decisões
// estratégicas e NÃO finge ter executado algo que o sistema não executou. Sua função:
// resumir, organizar, e sugerir/encaminhar para o especialista certo — mas a CEO
// sempre pode falar direto com qualquer diretor sem passar por ela (já garantido no
// frontend: os diretores são clicáveis diretamente).
const proposalService = require('./proposalService');
const dashboardService = require('./dashboardService');
const notificationService = require('./notificationService');
const conversationalBrain = require('./conversationalBrain');
const db = require('../db');

const { DIRECTOR_LABEL, DIRECTOR_ARTICLE } = conversationalBrain;

function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

// FASE 10.5 — Respostas humanizadas: variações naturais, como uma pessoa real
const GREETING_OPENERS = [
  'Oi! Que bom te ver por aqui.',
  'Oii! Tava te esperando.',
  'Hey! Chegou na hora certa.',
  'Olá! Como você está?',
  'Oi, tudo bem?',
  'Opa! Bem-vinda de volta.',
];

const RETURN_PHRASES = [
  'Enquanto você esteve fora, a equipe não parou.',
  'Tenho algumas coisas pra te contar.',
  'Deixa eu te atualizar rapidinho.',
  'Separei o que é mais importante pra você.',
  'Vem cá, olha só como estão as coisas.',
  'Trouxe um resuminho do que rolou.',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function greetingLine(userId) {
  let firstName = null;
  if (userId) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    if (u && u.name) firstName = u.name.split(' ')[0];
  }
  return `${pick(GREETING_OPENERS)}${firstName ? ` ${firstName}` : ''} ${pick(RETURN_PHRASES)}`;
}

/** Resumo diário com tom natural e acolhedor — como uma chefe de gabinete real. */
function dailySummary(userId) {
  const d = dashboardService.getDashboard();
  const lines = [greetingLine(userId), ''];

  const unread = notificationService.listForRole('ceo', { unreadOnly: true });
  if (unread.length > 0) {
    lines.push(`📬 Você tem ${unread.length} notificação(ões) nova(s):`);
    unread.slice(0, 3).forEach(n => lines.push(`  • ${n.message}`));
    if (unread.length > 3) lines.push(`  ...e mais ${unread.length - 3}.`);
    lines.push('');
  }

  if (d.pending_proposals_count > 0) {
    lines.push(`⏳ Tem ${d.pending_proposals_count} proposta${d.pending_proposals_count === 1 ? '' : 's'} esperando sua decisão — ${d.pending_proposals_count === 1 ? 'dá uma olhadinha?' : 'vale dar uma olhada quando puder.'}`);
  } else {
    lines.push('✅ Nenhuma proposta pendente no momento, tudo em dia!');
  }

  if (d.low_stock_products.length > 0) {
    lines.push('');
    lines.push(`⚠️ Olha, tô preocupada com o estoque de: ${d.low_stock_products.map(p => `${p.name} (${p.available_balance} un.)`).join(', ')}. Talvez seja hora de falar com o Diego.`);
  }

  const kitsAwaitingClosure = d.kits_by_status.aguardando_fechamento || 0;
  if (kitsAwaitingClosure > 0) {
    lines.push('');
    lines.push(`📦 ${kitsAwaitingClosure} kit${kitsAwaitingClosure === 1 ? '' : 's'} aguardando fechamento — quando der, vale conferir.`);
  }

  lines.push('');
  lines.push(`💰 Lucro líquido confirmado: ${(d.financial.lucro_liquido_cents/100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' })}`);
  lines.push(`👩‍💼 ${d.active_resellers} revendedora${d.active_resellers === 1 ? '' : 's'} ativa${d.active_resellers === 1 ? '' : 's'} de ${d.total_resellers} no total.`);

  if (d.recent_audit.length > 0) {
    lines.push('');
    lines.push(`🕐 Última atividade: ${d.recent_audit[0].actor_label} — ${d.recent_audit[0].action}`);
  }

  lines.push('');
  lines.push(pick([
    'Se precisar de algo, é só falar! 💕',
    'Qualquer coisa, tô por aqui. 🌸',
    'Quer que eu peça algo pra alguém da equipe?',
    'Posso te ajudar com mais alguma coisa?',
  ]));

  return lines.join('\n');
}

// FASE 10.5 — Encaminhamentos humanizados (como Ana falaria na vida real)
const FORWARD_PHRASES = {
  diego: [
    'Isso é lá com o Diego! Ele cuida de tudo de estoque e produtos.',
    'Hmm, estoque e produtos? O Diego é a pessoa certa pra isso.',
    'Vou te encaminhar pro Diego — ele resolve rapidinho.',
  ],
  marina: [
    'Isso é com a Marina! Ela cuida das revendedoras e do RH.',
    'Revendedora? A Marina é quem manda nisso, vou te passar pra ela.',
    'Deixa comigo, vou te encaminhar pra Marina — ela adora cuidar disso.',
  ],
  renata: [
    'Dinheiro? Isso é com a Renata, ela é super cuidadosa com os números.',
    'Vou te passar pra Renata — financeiro é a especialidade dela.',
    'A Renata é a pessoa perfeita pra isso, vou te encaminhar.',
  ],
  ricardo: [
    'Vendas e metas? O Ricardo é quem manda nisso!',
    'Vou te passar pro Ricardo — ele acompanha tudo de comercial.',
    'O Ricardo adora falar de vendas, vou te encaminhar pra ele.',
  ],
  theo: [
    'Marketing? Isso é com o Theo, ele é super criativo!',
    'Vou te passar pro Theo — campanhas e ideias são com ele.',
    'O Theo é a pessoa certa pra pensar nisso contigo.',
  ],
  arthur: [
    'Uma visão estratégica? O Arthur é nosso conselheiro, vou te passar pra ele.',
    'O Arthur adora uma análise mais profunda, vou te encaminhar.',
    'Pra pensar no todo, o Arthur é a pessoa. Vou te conectar.',
  ],
};

async function handleAnaMessage({ text, userId }) {
  const lower = text.trim().toLowerCase();
  // FASE 10.5 — Reconhecer saudações
  if (/^(oi|ol[aá]|hey|hello|hi|e[aíi]|fala|boa|bom dia|boa tarde|boa noite|resumo|resumo di[áa]rio|como (est[áa]|andam|vai|t[aá])|tudo bem|qual [eé] a boa|not[ií]cias)/i.test(lower)) {
    return { reply: dailySummary(userId), proposal: null };
  }

  const director = await conversationalBrain.classifyDirector(text);
  if (director !== 'ana') {
    const label = DIRECTOR_LABEL[director];
    const phrase = pick(FORWARD_PHRASES[director] || [`Isso é com ${label}, vou te encaminhar.`]);
    return {
      reply: `${phrase}\n\nClica em "${label}" na lista ao lado pra falar direto com ${DIRECTOR_ARTICLE[director]} — eu não tomo decisões por conta própria, mas adoro conectar as pessoas certas! 😊`,
      proposal: null,
    };
  }

  return {
    reply: pick([
      'Hmm, não tenho certeza de quem é a melhor pessoa pra isso. 😅\n\nMas ó, aqui vai um resumo de quem cuida do quê:\n• 📦 Diego — estoque e produtos\n• 👩‍💼 Marina — revendedoras e RH\n• 💰 Renata — financeiro e preços\n• 📈 Ricardo — vendas e metas\n• 🎨 Theo — marketing e campanhas\n• 🧠 Arthur — visão estratégica\n\nTenta falar direto com um deles, ou me conta melhor o que precisa!',
      'Não consegui identificar exatamente quem cuida disso. 🤔\n\nMe conta um pouquinho mais? Ou se preferir, fala direto com:\n• Diego (estoque)\n• Marina (revendedoras)\n• Renata (financeiro)\n• Ricardo (vendas)\n• Theo (marketing)\n• Arthur (conselheiro)',
    ]),
    proposal: null,
  };
}

proposalService.registerMessageHandler('ana', handleAnaMessage);

module.exports = { dailySummary, handleAnaMessage };

