// Cérebro Conversacional (Seção 1, prioridade máxima do documento de revisão final).
//
// Este módulo NÃO duplica nenhuma regra de negócio — ele só decide "quem deveria
// responder isso?" e delega para o handler daquele diretor, que já existe e já
// sabe extrair dados e criar propostas (src/proposalService.js). Isso segue a
// Seção 9 do documento: "Não criar novos módulos. Apenas conectar os existentes."
//
// Duas formas de uso:
//   1) A CEO está numa conversa explícita com um diretor (clicou "Diego" ou digitou
//      "@Diego") -> vai direto para aquele diretor, sem reclassificar (Seção 3: uma
//      menção explícita nunca deve ser desviada para outro lugar).
//   2) A CEO manda uma mensagem solta, de qualquer aba, sem indicar quem deve
//      responder (ex.: pela Ana, ou por um campo de mensagem global) -> este módulo
//      classifica qual diretor deveria tratar aquilo e delega para ele.
const proposalService = require('./proposalService');
const aiGateway = require('./aiGateway');
const productDraftService = require('./productDraftService');
const {
  parsePurchaseMessage, parseHireMessage, parseExpenseMessage,
  parsePricingProposalMessage, parseUpdateResellerMessage, parseDeactivateResellerMessage,
} = require('./events');

// Descrição curta de cada diretor — usada tanto para o prompt de classificação da
// IA quanto para a mensagem de fallback quando ninguém reconhece a intenção.
const DIRECTORS = {
  diego: 'Diretor de Estoque: compras de produto, cadastro de produto novo, entrada de mercadoria, fornecedores, níveis de estoque.',
  marina: 'Diretora de RH: contratação de revendedora, atualização de telefone/endereço, desligamento de revendedora.',
  renata: 'Diretora Financeira: despesas pagas, política de comissão/preço, margem, lucro.',
  theo: 'Diretor de Marketing: criação de campanhas, calendário comercial.',
  ricardo: 'Diretor Comercial: metas de venda, desempenho, ticket médio (NÃO registra vendas individuais — isso é feito pela própria revendedora no fechamento do kit).',
  arthur: 'Conselheiro Estratégico: síntese e diagnóstico entre áreas — não executa ações.',
  ana: 'Chefe de Gabinete: resumo do dia, dúvidas gerais, ou qualquer assunto que não seja claramente de outro diretor.',
};

const KNOWN_DIRECTOR_THREADS = new Set(Object.keys(DIRECTORS));

const DIRECTOR_LABEL = { diego: 'Diego', marina: 'Marina', renata: 'Renata', theo: 'Theo', ricardo: 'Ricardo', arthur: 'Arthur', ana: 'Ana' };
const DIRECTOR_ARTICLE = { diego: 'ele', marina: 'ela', renata: 'ela', theo: 'ele', ricardo: 'ele', arthur: 'ele', ana: 'ela' };

// Heurística offline (sem IA): reaproveita os parsers determinísticos já existentes
// como "sinais" de intenção, e complementa com palavras-chave simples para os
// diretores que não têm parser estruturado (Theo, Ricardo). É o mesmo mecanismo que
// já existia em anaService.js — centralizado aqui para não duplicar.
const KEYWORD_HINTS = [
  { director: 'diego', test: (t) => parsePurchaseMessage(t).recognized || productDraftService.isStartTrigger(t) },
  { director: 'marina', test: (t) => parseHireMessage(t).recognized || parseUpdateResellerMessage(t).recognized || parseDeactivateResellerMessage(t).recognized },
  { director: 'renata', test: (t) => parseExpenseMessage(t).recognized || parsePricingProposalMessage(t).recognized },
  { director: 'theo', test: (t) => /\bcampanha\b|marketing|tend[êe]ncia/i.test(t) },
  { director: 'ricardo', test: (t) => /\bmeta\b|desempenho|ticket m[ée]dio/i.test(t) },
  { director: 'arthur', test: (t) => /an[áa]lise\s+estrat[ée]gica|panorama geral|diagn[óo]stico/i.test(t) },
];

function classifyByKeywords(text) {
  const hit = KEYWORD_HINTS.find((h) => h.test(text));
  return hit ? hit.director : null;
}

/**
 * Decide qual diretor deve tratar uma mensagem livre. Tenta a IA primeiro (quando
 * configurada) porque ela entende frases fora dos padrões fixos, como os exemplos do
 * documento ("Yasmin vendeu três unidades.", "Fornecedor aumentou esse produto.").
 * Sem IA, ou se a IA não tiver confiança suficiente, cai na heurística por palavra-chave.
 * Retorna sempre uma das chaves de DIRECTORS (nunca null) — 'ana' é o padrão seguro.
 */
async function classifyDirector(text) {
  if (aiGateway.isAvailable()) {
    const schema = Object.keys(DIRECTORS).map((k) => `"${k}"`).join(' | ');
    const data = await aiGateway.extractJSON({
      system:
        'Você roteia mensagens da dona de uma empresa para o diretor certo dentro do sistema SexS OS. ' +
        'Escolha SEMPRE um dos diretores da lista, mesmo que a confiança seja baixa — "ana" é o roteamento ' +
        'padrão para assuntos gerais ou que nenhum outro diretor claramente cobre.',
      instruction:
        `Diretores disponíveis e o que cada um cobre:\n${Object.entries(DIRECTORS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
      text,
      schemaHint: `{"director": ${schema}, "confidence": "alta"|"media"|"baixa"}`,
    });
    if (data && KNOWN_DIRECTOR_THREADS.has(data.director)) return data.director;
  }
  return classifyByKeywords(text) || 'ana';
}

/**
 * Ponto de entrada único do cérebro conversacional. Funciona independentemente da
 * aba em que a CEO está: se `explicitThread` for um diretor conhecido (ela clicou
 * naquela conversa ou usou @menção), vai direto para ele. Caso contrário, classifica
 * e delega. Sempre reaproveita os handlers já registrados em proposalService — nunca
 * recria a lógica de extração/proposta aqui.
 */
async function routeMessage({ text, userId, explicitThread }) {
  // Uma conversa multi-turno em andamento (ex.: cadastro de produto) nunca pode ser
  // "roubada" por outro diretor no meio do caminho — mesmo vindo do widget global.
  const hasActiveProductDraft = userId && productDraftService.getActiveDraft(userId);
  const thread = hasActiveProductDraft
    ? 'diego'
    : (explicitThread && KNOWN_DIRECTOR_THREADS.has(explicitThread) && explicitThread !== 'ana'
        ? explicitThread
        : await classifyDirector(text));

  const result = await proposalService.handleDirectorMessage({ thread, text, userId });
  return { ...result, routed_to: thread };
}

/** Extrai "@nome" do início de uma mensagem (Seção 3) e devolve {thread, text} sem o @menção. */
function extractMention(text) {
  const match = text.trim().match(/^@(\p{L}+)\s*[:,-]?\s*(.*)$/u);
  if (!match) return { thread: null, text };
  const name = match[1].toLowerCase();
  if (!KNOWN_DIRECTOR_THREADS.has(name)) return { thread: null, text };
  return { thread: name, text: match[2] || text };
}

module.exports = { DIRECTORS, DIRECTOR_LABEL, DIRECTOR_ARTICLE, classifyDirector, routeMessage, extractMention };
