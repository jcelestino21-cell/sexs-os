// Motor de acontecimentos (Seção 7 do prompt mestre) — versão MVP.
//
// LIMITAÇÃO REAL E DECLARADA: este ambiente de execução não tem acesso à rede, então
// não é possível chamar a API da Anthropic para interpretação de linguagem natural
// livre. Para provar o fluxo ponta-a-ponta (Seção 4 e teste de aceitação 1/2), este
// módulo implementa reconhecimento determinístico do padrão de compra descrito na
// documentação oficial:
//   "Comprei 50 unidades do Lubrificante Morango por R$ 18 cada, do fornecedor Gall."
//
// A interface (parsePurchaseMessage -> {intent, entities, missing}) é a mesma que uma
// chamada real ao modelo deveria respeitar: a IA SÓ extrai intenção/entidades. Quem
// calcula preço, grava estoque e decide risco é sempre o código determinístico abaixo
// e em src/pricing.js / routes/proposals.js. Trocar este parser por uma chamada real ao
// Claude (Seção 7) não exige mudar nenhum outro módulo — é o ponto de extensão indicado
// no relatório final.

const aiGateway = require('./aiGateway');
const conversationMemory = require('./conversationMemory');

// ---------------------------------------------------------------------------------
// Assistência de IA (Seção 1 / 10): cada parser abaixo continua determinístico e é
// SEMPRE tentado primeiro — ele é o mecanismo offline garantido. Só quando o regex
// não reconhece a frase (ou reconhece com campos faltando) e existe IA configurada
// é que pedimos à IA para extrair os mesmos campos, no mesmo formato. A IA nunca
// substitui um valor que o regex já capturou — só preenche o que faltou. Se a IA
// estiver indisponível ou falhar, devolvemos exatamente o resultado do regex, sem
// nenhuma diferença de comportamento em relação a hoje.
//
// `recomputeMissing(entities)` é fornecido por quem chama, pois só cada parser sabe
// quais campos são obrigatórios e como rotulá-los em português.
// ---------------------------------------------------------------------------------
async function aiAssist(regexResult, { intent, schemaHint, instruction, text, recomputeMissing, userId, thread }) {
  const stillMissing = !regexResult.recognized || regexResult.missing.length > 0;
  if (!stillMissing || !aiGateway.isAvailable()) return regexResult;

  // Seção 4 ("cada diretor deve lembrar das conversas anteriores"): quando sabemos
  // qual CEO e qual diretor, injetamos o histórico recente da própria thread como
  // contexto — assim a IA pode entender referências como "aquele mesmo produto de
  // antes" em vez de tratar cada mensagem como se fosse a primeira conversa.
  const historyText = userId && thread ? conversationMemory.recentHistoryText(userId, thread) : '';

  // IMPORTANTE: vários handlers (ex.: Marina, Renata) testam mais de um parser em
  // sequência na mesma mensagem. Por isso a IA precisa confirmar explicitamente que
  // a mensagem É desse tipo de intenção antes de qualquer campo ser aproveitado —
  // caso contrário, uma mensagem de outra intenção (ex.: uma contratação) poderia
  // ser "roubada" pelo parser errado (ex.: atualização de contato) só por ter campos
  // em comum, travando a mensagem no handler errado.
  const aiData = await aiGateway.extractJSON({
    system:
      'Você extrai dados estruturados de mensagens de uma dona de empresa para o sistema de gestão SexS OS. ' +
      'Nunca invente valores. Se não tiver certeza de um campo, use null. Se a mensagem claramente NÃO for sobre ' +
      'este tipo de assunto, responda "matches": false e deixe os demais campos null.',
    instruction: historyText + instruction,
    text,
    schemaHint: schemaHint.replace('{', '{"matches": boolean, '),
  });
  if (!aiData || typeof aiData !== 'object' || aiData.matches !== true) return regexResult;

  const entities = { ...regexResult.entities };
  for (const [key, value] of Object.entries(aiData)) {
    if (key === 'matches') continue;
    if ((entities[key] === null || entities[key] === undefined || entities[key] === '') && value !== null && value !== undefined && value !== '') {
      entities[key] = value;
    }
  }

  const missing = recomputeMissing(entities);
  return { intent, entities, missing, recognized: true, source: 'ai_assist' };
}

const PURCHASE_REGEX =
  /comprei\s+(?<qty>\d+)\s+(?:unidades?\s+d[oa]s?\s+)?(?<product>.+?)\s+por\s+r?\$?\s?(?<price>[\d.,]+)\s*(?:reais?)?\s*(cada)?[,]?\s*(?:do\s+fornecedor\s+)?(?<supplier>.+)?$/i;

function parsePurchaseMessage(text) {
  const clean = text.trim().replace(/\.$/, '');
  const match = clean.match(PURCHASE_REGEX);

  if (!match || !match.groups) {
    return { intent: 'desconhecido', entities: {}, missing: [], recognized: false };
  }

  const { qty, product, price, supplier } = match.groups;
  const entities = {
    quantity: qty ? parseInt(qty, 10) : null,
    product_name: product ? product.trim() : null,
    unit_price_raw: price ? price.trim() : null,
    supplier_name: supplier ? supplier.trim() : null,
  };

  const missing = [];
  if (!entities.quantity) missing.push('quantidade');
  if (!entities.product_name) missing.push('produto');
  if (!entities.unit_price_raw) missing.push('preço unitário');
  if (!entities.supplier_name) missing.push('fornecedor');

  return { intent: 'compra_estoque', entities, missing, recognized: true };
}

// Padrão de contratação para Marina (RH): "Contratamos Patrícia" ou
// "Contratamos Patrícia, telefone 11999999999, endereço Rua X, 123".
// Mesma limitação declarada acima: reconhecimento determinístico de um padrão
// específico, não interpretação livre — ponto de extensão para IA real futura.
// FASE 10.5 — Parser de contratação flexível
// Aceita: "Contratamos Flavia, 16988638987, Rua Albano Bacega"
//         "Flavia, 16988638987, Rua Albano Bacega"
//         "Contratar Flavia telefone 16988638987 endereço Rua X"
const HIRE_INTENT = /^(contratamos|contratar|nova\s+revendedora|cadastrar\s+revendedora|admitir|contrata[çc][aã]o\s+de|quero\s+contratar|vai\s+trabalhar|nova\s+vendedora|quer\s+trabalhar|come[çc]ou\s+a?\s*trabalhar|(?:a\s+)?\w+\s+(?:quer|vai|come[çc]ou)\s+(?:trabalhar|vender)|revendedora\s+nova)\b/i;

function parseHireMessage(text) {
  const clean = text.trim().replace(/\.$/, '');

  // 1) Formato estruturado com "Contratamos" + labels
  const structured = clean.match(/^contratamos\s+(?<name>[^,]+)(,\s*(?<rest>.*))?$/i);
  if (structured && structured.groups && structured.groups.name) {
    const name = structured.groups.name.trim();
    const rest = structured.groups.rest || '';
    let phone = null, address = null;
    // Telefone: sequência de 8+ dígitos com formatação opcional
    const phoneMatch = rest.match(/(\(?\d{2}\)?[\s\-]?\d[\d\s\-]{6,})/);
    if (phoneMatch) phone = phoneMatch[1].trim();
    // Endereço: texto após "endereço" ou que contém rua/av/etc
    const addrLabel = rest.match(/endere[çc]o\s*[:\-]?\s*(.+)/i);
    if (addrLabel) address = addrLabel[1].trim();
    else { const addrLoose = rest.match(/((?:rua|av\.?|avenida|travessa)\s+[^,]+)/i); if (addrLoose) address = addrLoose[1].trim(); }
    const entities = { name, phone, address };
    const missing = [];
    if (!phone) missing.push('telefone');
    // endereço é opcional
    return { intent: 'contratar_revendedora', entities, missing, recognized: true };
  }

  // 2) Com intenção + dados separados por vírgula
  if (HIRE_INTENT.test(clean)) {
    const after = clean.replace(HIRE_INTENT, '').replace(/^[\s,:\-]+/, '').trim();
    const parts = after.split(',').map(p => p.trim()).filter(Boolean);
    let name = null, phone = null, address = null;
    for (const part of parts) {
      const digits = part.replace(/\D/g, '');
      if (!phone && digits.length >= 8 && digits.length <= 13) {
        phone = digits.length >= 10 ? digits.slice(0,2) + ' ' + digits.slice(2,7) + '-' + digits.slice(7) : digits;
      } else if (!address && (/(rua|avenida|av\.?|travessa|alameda|rodovia|pra[çc]a)/i.test(part) || part.length > 8)) {
        address = part;
      } else if (!name) {
        name = part;
      } else if (!address) {
        address = part;
      }
    }
    if (name) {
      const entities = { name, phone, address };
      const missing = [];
      if (!phone) missing.push('telefone');
      // endereço é opcional
      return { intent: 'contratar_revendedora', entities, missing, recognized: true };
    }
  }

  // 3) Formato solto: "Flavia, 16988638987, Rua Albano Bacega"
  const loose = clean.match(/^([^,]+?),\s*(\(?\d{2}\)?[\s\-]?\d[\d\s\-]{6,})\s*,\s*(.+)/i);
  if (loose) {
    const name = loose[1].trim();
    if (name.length > 1 && !/^(oi|ol[aá]|resumo|paguei|comprei|proponha|crie)/i.test(name)) {
      return { intent: 'contratar_revendedora', entities: { name, phone: loose[2].trim(), address: loose[3].trim() }, missing: [], recognized: true };
    }
  }

  // 4) Linguagem natural: "a Juliana quer trabalhar com a gente, zap dela é 16 99999-1234, mora na rua das flores"
  const phoneAnywhere = clean.match(/(?:zap|tel|telefone|fone|whats|celular|contato)[^0-9]{0,30}(\(?[0-9]{2}\)?[\s\-]?[0-9]{4,5}[\s\-]?[0-9]{4})/i)
    || clean.match(/(\([0-9]{2}\)\s*[0-9]{4,5}[\s\-][0-9]{4})/)
    || clean.match(/((?:1[1-9]|[2-9][0-9])[\s\-]?[0-9]{4,5}[\s\-]?[0-9]{4})/);
  const addrAnywhere = clean.match(/(?:mora|endere[çc]o|rua|avenida|av\.?|travessa|alameda)\s*(?:em|na|no|de|:|=)?\s*((?:rua|av\.?|avenida|travessa|alameda|rodovia|pra[çc]a)\s+[^,]+)/i)
    || clean.match(/(?:mora|endere[çc]o)\s*(?:em|na|no|:)?\s*([^,]{5,})/i);
  const hasHireIntent = /(?:quer|vai|come[çc]ou)\s+(?:trabalhar|vender|ser\s+revendedora)|trabalhar\s+(?:com\s+a\s+gente|conosco|na\s+empresa)|revendedora\s+nova|nova\s+(?:revendedora|vendedora)|contrat/i.test(clean);

  if (hasHireIntent && phoneAnywhere) {
    let name = null;
    const nameMatch = clean.match(/^(?:a\s+|o\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/)
      || clean.match(/(?:contratar|contratamos|chama(?:da|do)?|nome)\s+(?:a\s+|o\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i);
    if (nameMatch) name = nameMatch[1].trim();
    const phone = phoneAnywhere[1].trim();
    const address = addrAnywhere ? addrAnywhere[1].trim() : null;
    if (name) {
      return { intent: 'contratar_revendedora', entities: { name, phone, address }, missing: [], recognized: true };
    }
  }

  return { intent: 'desconhecido', entities: {}, missing: [], recognized: false };
}

const UPDATE_CONTACT_REGEX = /^(?:a\s+)?(?<name>[^,]+?)\s+mudou\s+(?:de\s+)?(?<field>telefone|endere[çc]o)\s*(?:para)?\s*[:\-]?\s*(?<value>.+)$/i;

function parseUpdateResellerMessage(text) {
  const clean = text.trim().replace(/\.$/, '');
  const match = clean.match(UPDATE_CONTACT_REGEX);
  if (!match || !match.groups) return { intent: 'desconhecido', entities: {}, missing: [], recognized: false };
  const fieldRaw = match.groups.field.toLowerCase();
  const field = fieldRaw.startsWith('tele') ? 'phone' : 'address';
  return {
    intent: 'atualizar_revendedora', recognized: true, missing: [],
    entities: { name: match.groups.name.trim(), field, value: match.groups.value.trim() },
  };
}

// "Flávia saiu da empresa." / "Fulana não é mais revendedora."
const DEACTIVATE_REGEX = /^(?:a\s+)?(?<name>[^,]+?)\s+(?:saiu\s+da\s+empresa|n[ãa]o\s+[ée]\s+mais\s+revendedora|foi\s+desligada)\s*$/i;

function parseDeactivateResellerMessage(text) {
  const clean = text.trim().replace(/\.$/, '');
  const match = clean.match(DEACTIVATE_REGEX);
  if (!match || !match.groups) return { intent: 'desconhecido', entities: {}, missing: [], recognized: false };
  return { intent: 'desativar_revendedora', recognized: true, missing: [], entities: { name: match.groups.name.trim() } };
}

// Padrão de despesa para Renata: "Paguei R$ 200 de internet do escritório, categoria despesas fixas"
const EXPENSE_REGEX = /^(?:paguei|gastei|despesa\s+de|gasto\s+de|pago\s+de|custou|comprei|investi)\s+r?\$?\s*(?<amount>[\d.,]+)\s*(?:reais?)?\s*(?:de|com|em|no|na|para)\s+(?<description>[^,]+)(?:,\s*categoria\s+(?<category>.+))?$/i;

function parseExpenseMessage(text) {
  const clean = text.trim().replace(/\.$/, '');
  const match = clean.match(EXPENSE_REGEX);
  if (!match || !match.groups) return { intent: 'desconhecido', entities: {}, missing: [], recognized: false };

  const entities = {
    amount_raw: match.groups.amount ? match.groups.amount.trim() : null,
    description: match.groups.description ? match.groups.description.trim() : null,
    category: match.groups.category ? match.groups.category.trim() : 'geral',
  };
  const missing = [];
  if (!entities.amount_raw) missing.push('valor');
  if (!entities.description) missing.push('descrição');

  return { intent: 'registrar_despesa', entities, missing, recognized: true };
}

// Padrão de proposta de política de preço para Renata:
// "Renata, proponha comissão de 25% e multiplicador de 3.5"
const PRICING_REGEX = /comiss[ãa]o\s+de\s+(?<commission>[\d.,]+)\s*%.*multiplicador\s+de\s+(?<multiplier>[\d.,]+)/i;

function parsePricingProposalMessage(text) {
  const match = text.match(PRICING_REGEX);
  if (!match || !match.groups) return { intent: 'desconhecido', entities: {}, missing: [], recognized: false };

  const commissionPct = parseFloat(match.groups.commission.replace(',', '.')) / 100;
  const costMultiplier = parseFloat(match.groups.multiplier.replace(',', '.'));

  const missing = [];
  if (Number.isNaN(commissionPct)) missing.push('comissão');
  if (Number.isNaN(costMultiplier)) missing.push('multiplicador de custo');

  return {
    intent: 'nova_regra_precificacao',
    entities: { commission_pct: commissionPct, cost_multiplier: costMultiplier },
    missing, recognized: true,
  };
}

// ---------------------------------------------------------------------------------
// Versões "Smart": tentam o regex determinístico primeiro (idêntico a antes) e só
// recorrem à IA quando ele não reconhece a frase ou reconhece com campos faltando.
// São estas que os handlers de cada diretor devem chamar a partir de agora — a
// versão regex pura continua exportada e funcionando sozinha para quem depender dela
// diretamente (ex.: testes automatizados existentes).
// ---------------------------------------------------------------------------------

async function parsePurchaseMessageSmart(text, userId) {
  const base = parsePurchaseMessage(text);
  return aiAssist(base, {
    intent: 'compra_estoque',
    userId, thread: 'diego',
    text,
    instruction:
      'Extraia os dados de uma compra de estoque relatada pela CEO (quantidade, nome do produto, preço unitário e ' +
      'fornecedor). Se a quantidade não for dita, assuma 1. Se o fornecedor não for dito, use null.',
    schemaHint: '{"quantity": number|null, "product_name": string|null, "unit_price_raw": string|null, "supplier_name": string|null}',
    recomputeMissing: (e) => {
      const missing = [];
      if (!e.quantity) missing.push('quantidade');
      if (!e.product_name) missing.push('produto');
      if (!e.unit_price_raw) missing.push('preço unitário');
      if (!e.supplier_name) missing.push('fornecedor');
      return missing;
    },
  });
}

async function parseHireMessageSmart(text, userId) {
  const base = parseHireMessage(text);
  return aiAssist(base, {
    intent: 'contratar_revendedora',
    userId, thread: 'marina',
    text,
    instruction: 'Extraia o nome, telefone e endereço de uma nova revendedora contratada, se mencionados.',
    schemaHint: '{"name": string|null, "phone": string|null, "address": string|null}',
    recomputeMissing: (e) => {
      const missing = [];
      if (!e.name) missing.push('nome');
      if (!e.phone) missing.push('telefone');
      if (!e.address) missing.push('endereço');
      return missing;
    },
  });
}

async function parseExpenseMessageSmart(text, userId) {
  const base = parseExpenseMessage(text);
  return aiAssist(base, {
    intent: 'registrar_despesa',
    userId, thread: 'renata',
    text,
    instruction: 'Extraia o valor pago, a descrição da despesa e a categoria (se não houver categoria clara, use "geral").',
    schemaHint: '{"amount_raw": string|null, "description": string|null, "category": string|null}',
    recomputeMissing: (e) => {
      const missing = [];
      if (!e.amount_raw) missing.push('valor');
      if (!e.description) missing.push('descrição');
      return missing;
    },
  });
}

async function parsePricingProposalMessageSmart(text, userId) {
  const base = parsePricingProposalMessage(text);
  return aiAssist(base, {
    intent: 'nova_regra_precificacao',
    userId, thread: 'renata',
    text,
    instruction: 'Extraia a comissão proposta (em % convertido para fração, ex.: 25% -> 0.25) e o multiplicador de custo propostos.',
    schemaHint: '{"commission_pct": number|null, "cost_multiplier": number|null}',
    recomputeMissing: (e) => {
      const missing = [];
      if (e.commission_pct === null || e.commission_pct === undefined) missing.push('comissão');
      if (e.cost_multiplier === null || e.cost_multiplier === undefined) missing.push('multiplicador de custo');
      return missing;
    },
  });
}

async function parseUpdateResellerMessageSmart(text, userId) {
  const base = parseUpdateResellerMessage(text);
  return aiAssist(base, {
    intent: 'atualizar_revendedora',
    userId, thread: 'marina',
    text,
    instruction: 'Extraia o nome da revendedora, o campo alterado ("phone" ou "address") e o novo valor.',
    schemaHint: '{"name": string|null, "field": "phone"|"address"|null, "value": string|null}',
    recomputeMissing: (e) => {
      const missing = [];
      if (!e.name) missing.push('nome');
      if (!e.field) missing.push('campo alterado');
      if (!e.value) missing.push('novo valor');
      return missing;
    },
  });
}

async function parseDeactivateResellerMessageSmart(text, userId) {
  const base = parseDeactivateResellerMessage(text);
  return aiAssist(base, {
    intent: 'desativar_revendedora',
    userId, thread: 'marina',
    text,
    instruction: 'Extraia apenas o nome da revendedora que saiu da empresa.',
    schemaHint: '{"name": string|null}',
    recomputeMissing: (e) => (!e.name ? ['nome'] : []),
  });
}

module.exports = {
  aiAssist,
  parsePurchaseMessage, parseHireMessage, parseExpenseMessage, parsePricingProposalMessage,
  parseUpdateResellerMessage, parseDeactivateResellerMessage,
  parsePurchaseMessageSmart, parseHireMessageSmart, parseExpenseMessageSmart,
  parsePricingProposalMessageSmart, parseUpdateResellerMessageSmart, parseDeactivateResellerMessageSmart,
};
