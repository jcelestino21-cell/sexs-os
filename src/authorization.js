// Autorização por capacidade, não por papel genérico (Correção Seção 4).
//
// "diretor" sozinho NÃO concede acesso a nada sensível — cada director_key tem um
// conjunto explícito de capacidades. A CEO tem todas. Revendedora nunca tem nenhuma
// destas (seu acesso é tratado à parte, por requireReseller + checagem de posse).
//
// Isto é a autoridade real: o frontend só usa isto para decidir o que MOSTRAR, nunca
// para decidir o que PERMITIR — a decisão de permissão sempre acontece aqui, no
// servidor, mesmo que a pessoa manipule a URL ou chame a API diretamente.

const DIRECTOR_CAPABILITIES = {
  diego: new Set([
    'stock:read', 'stock:write', 'products:read', 'suppliers:read',
    'kits:read', 'kits:manage', 'orders:read', 'resellers:basic',
    'council:participate',
  ]),
  marina: new Set([
    'resellers:read', 'resellers:write', 'resellers:personal',
    'documents:read', 'documents:write', 'tips:write',
    'council:participate',
  ]),
  renata: new Set([
    'financial:read', 'financial:write', 'pricing:read', 'pricing:write',
    'expenses:write', 'commission:read', 'resellers:basic',
    'council:participate',
  ]),
  ricardo: new Set([
    'commercial:read', 'ranking:read', 'goals:write', 'resellers:basic',
    'council:participate',
  ]),
  theo: new Set([
    'marketing:read', 'marketing:write', 'products:names',
    'council:participate',
  ]),
  arthur: new Set([
    'advisory:read', 'council:participate',
  ]),
};

/** Todo diretor pode participar do Conselho e ver o próprio painel de decisões —
 * isso não é um vazamento de dados, é coordenação explícita da Seção 5. */
const UNIVERSAL_DIRECTOR_CAPABILITIES = new Set(['council:view']);

function hasCapability(user, capability) {
  if (!user) return false;
  if (user.role === 'ceo') return true;
  if (user.role !== 'diretor') return false;
  if (UNIVERSAL_DIRECTOR_CAPABILITIES.has(capability)) return true;
  const caps = DIRECTOR_CAPABILITIES[user.director_key];
  return caps ? caps.has(capability) : false;
}

/** Lista de capacidades do usuário logado — usada pelo frontend só para decidir o
 * que EXIBIR (esconder uma aba que o servidor recusaria de qualquer forma). */
function capabilitiesFor(user) {
  if (!user) return [];
  if (user.role === 'ceo') return ['*'];
  if (user.role !== 'diretor') return [];
  const caps = DIRECTOR_CAPABILITIES[user.director_key] || new Set();
  return [...caps, ...UNIVERSAL_DIRECTOR_CAPABILITIES];
}

module.exports = { hasCapability, capabilitiesFor, DIRECTOR_CAPABILITIES };
