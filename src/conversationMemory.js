// Memória das Conversas (Seção 4).
//
// A tabela conversation_messages já guardava o histórico por thread — ela só não
// era usada como CONTEXTO nas respostas. Este módulo é o que fecha essa lacuna:
// busca as últimas mensagens de uma conversa e formata como texto para ser
// injetado no prompt da IA, para que o diretor "lembre" do que já foi falado.
//
// Continua funcionando sem IA: quando não há IA configurada, este módulo
// simplesmente não é chamado (o mecanismo offline não muda) — memória vira
// contexto de verdade só quando existe alguém (a IA) capaz de "ler" e usar esse
// contexto para responder. Sem IA, a memória já existe do jeito possível hoje:
// o histórico completo fica visível na tela para a própria CEO reler.
const db = require('../db');

const DEFAULT_LIMIT = 16;

/** Últimas mensagens de uma conversa (CEO <-> diretor), da mais antiga para a mais nova. */
function getRecentHistory(userId, thread, limit = DEFAULT_LIMIT) {
  const rows = db
    .prepare('SELECT sender, body, created_at FROM conversation_messages WHERE user_id = ? AND thread = ? ORDER BY id DESC LIMIT ?')
    .all(userId, thread, limit);
  return rows.reverse();
}

/** Formata o histórico como um bloco de texto simples para entrar no prompt da IA. */
function formatHistoryForPrompt(rows) {
  if (!rows.length) return '';
  const lines = rows.map((r) => `${r.sender === 'ceo' ? 'CEO' : 'Você'}: ${r.body}`);
  return `Histórico recente desta conversa (mais antiga primeiro):\n${lines.join('\n')}\n\n`;
}

/** Atalho: já busca e formata de uma vez. Vazio ("") se não houver histórico. */
function recentHistoryText(userId, thread, limit = DEFAULT_LIMIT) {
  return formatHistoryForPrompt(getRecentHistory(userId, thread, limit));
}

module.exports = { getRecentHistory, formatHistoryForPrompt, recentHistoryText };
