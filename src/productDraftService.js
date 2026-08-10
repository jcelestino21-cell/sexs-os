// Cadastro conversacional de produto (multi-turno): a CEO responde uma pergunta por
// vez, como no exemplo do documento de especificação — nunca um formulário inteiro
// de uma vez. O estado fica em `product_drafts` (uma linha "em_andamento" por CEO)
// entre uma mensagem e outra.
const db = require('../db');

const FIELD_ORDER = ['name', 'category', 'brand', 'supplier_name', 'purchase_cost_raw', 'quantity', 'photo_url'];

const FIELD_QUESTIONS = {
  name: 'Qual o nome do produto?',
  category: 'Qual a categoria dele?',
  brand: 'Qual a marca?',
  supplier_name: 'De qual fornecedor?',
  purchase_cost_raw: 'Qual foi o valor de compra, por unidade?',
  quantity: 'Quantas unidades chegaram?',
  photo_url: 'Tem uma foto? Cole o link, ou digite "pular" se não tiver agora.',
};

const START_TRIGGER = /^(chegou\s+(um\s+)?produto\s+novo|produto\s+novo|cadastrar\s+(um\s+)?produto|novo\s+produto)\b/i;
const CANCEL_TRIGGER = /^(cancela|cancelar|deixa\s+pra\s+l[áa]|esquece)\b/i;

function isStartTrigger(text) { return START_TRIGGER.test(text.trim()); }
function isCancelTrigger(text) { return CANCEL_TRIGGER.test(text.trim()); }

function getActiveDraft(userId) {
  const row = db.prepare(`SELECT * FROM product_drafts WHERE user_id = ? AND status = 'em_andamento' ORDER BY id DESC LIMIT 1`).get(userId);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data_json) };
}

function startDraft(userId) {
  // Só um rascunho em andamento por vez — se havia um esquecido, cancela antes.
  db.prepare(`UPDATE product_drafts SET status='cancelado', updated_at=datetime('now') WHERE user_id=? AND status='em_andamento'`).run(userId);
  db.prepare(`INSERT INTO product_drafts (user_id, data_json) VALUES (?, '{}')`).run(userId);
  return getActiveDraft(userId);
}

function cancelDraft(draftId) {
  db.prepare(`UPDATE product_drafts SET status='cancelado', updated_at=datetime('now') WHERE id=?`).run(draftId);
}

function nextMissingField(draft) {
  return FIELD_ORDER.find((f) => draft.data[f] === undefined || draft.data[f] === null || draft.data[f] === '');
}

function isComplete(draft) {
  return nextMissingField(draft) === undefined;
}

/** Grava a resposta da CEO no campo que estava pendente e devolve o rascunho atualizado. */
function answerField(draft, fieldKey, rawAnswer) {
  const value = fieldKey === 'photo_url' && /^pular$/i.test(rawAnswer.trim()) ? '(sem foto)' : rawAnswer.trim();
  const data = { ...draft.data, [fieldKey]: value };
  db.prepare(`UPDATE product_drafts SET data_json = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(data), draft.id);
  return { ...draft, data };
}

function finalizeDraft(draftId) {
  db.prepare(`UPDATE product_drafts SET status='concluido', updated_at=datetime('now') WHERE id=?`).run(draftId);
}

module.exports = { FIELD_ORDER, FIELD_QUESTIONS, isStartTrigger, isCancelTrigger, getActiveDraft, startDraft, cancelDraft, nextMissingField, isComplete, answerField, finalizeDraft };
