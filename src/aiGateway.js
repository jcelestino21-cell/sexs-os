// AI Gateway (Seção 10) — camada desacoplada de acesso a IA externa.
//
// Nenhum outro módulo do sistema fala HTTP com um provedor de IA diretamente.
// Todos passam por aqui. Isso é o que permite trocar de provedor (ou remover a IA
// por completo) sem tocar em nenhuma regra de negócio.
//
// Contrato: `extractJSON({ system, instruction, text, schemaHint })` SEMPRE resolve
// (nunca rejeita) — em caso de provedor ausente, erro de rede, timeout ou resposta
// que não seja um JSON válido, retorna `null`. Quem chama trata `null` exatamente
// como "IA indisponível agora" e cai no mecanismo offline existente (regex
// determinístico em src/events.js). Isso implementa literalmente a Seção 1:
// "Quando existir IA configurada, utilizar IA. Quando não existir, utilizar o
// mecanismo offline existente. A arquitetura deve funcionar perfeitamente nos dois
// modos." — e também protege o sistema de uma IA que "alucina" e derruba um fluxo
// financeiro: o pior caso possível é o mesmo de hoje, sem IA nenhuma.
//
// A IA NUNCA executa nada sozinha. Ela só devolve texto/JSON. Quem decide risco,
// calcula preço, grava no banco e pede aprovação da CEO continua sendo o código
// determinístico em cada módulo de negócio (src/pricing.js, src/proposalService.js
// etc.) — isso não muda com este arquivo.

const DEFAULT_TIMEOUT_MS = 15000;

function detectProvider() {
  const forced = (process.env.AI_PROVIDER || '').toLowerCase().trim();
  if (forced) return forced;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_HOST || process.env.OLLAMA_MODEL) return 'ollama';
  return null;
}

function isAvailable() {
  return detectProvider() !== null;
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI Gateway: tempo limite de ${ms}ms excedido`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Extrai o primeiro bloco JSON válido de uma string (tolera texto/markdown ao redor). */
function extractJsonBlock(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt({ instruction, text, schemaHint }) {
  return (
    `${instruction}\n\n` +
    (schemaHint ? `Responda APENAS com um JSON no formato:\n${schemaHint}\n\n` : '') +
    `Se algum campo não puder ser determinado com segurança a partir da mensagem, use null nesse campo — nunca invente um valor.\n\n` +
    `Mensagem da CEO:\n"""${text}"""`
  );
}

async function callAnthropic({ system, prompt }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function callOpenAI({ system, prompt }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini({ system, prompt }) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 800,
          temperature: 0.8,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    // Gemini 3.x pode retornar content vazio se maxOutputTokens for muito baixo
    throw new Error('Gemini retornou resposta vazia (tokens insuficientes?)');
  }
  return parts.map((p) => p.text).filter(Boolean).join('\n');
}

async function callOllama({ system, prompt }) {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const res = await fetch(`${host.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3.1',
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content || '';
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini, ollama: callOllama };

/**
 * Pede à IA configurada para extrair dados estruturados de uma mensagem em
 * linguagem natural. Retorna o objeto JSON já parseado, ou `null` se a IA não
 * estiver configurada, falhar, ou não devolver JSON válido — NUNCA lança exceção.
 */
async function extractJSON({ system, instruction, text, schemaHint, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const provider = detectProvider();
  if (!provider) return null;
  const caller = CALLERS[provider];
  if (!caller) return null;

  const prompt = buildPrompt({ instruction, text, schemaHint });
  try {
    const raw = await withTimeout(caller({ system, prompt }), timeoutMs);
    return extractJsonBlock(raw);
  } catch (err) {
    // Falha de IA nunca deve derrubar um fluxo de negócio — apenas registra e
    // deixa quem chamou cair no mecanismo offline.
    console.warn(`[aiGateway] provedor "${provider}" falhou: ${err.message}`);
    return null;
  }
}

/**
 * Pede à IA um texto livre (não-JSON) — usado para o debate do conselho executivo
 * e para respostas conversacionais mais ricas. Retorna string, ou `null` no mesmo
 * espírito de extractJSON: falha de IA nunca deve travar a conversa.
 */
async function complete({ system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const provider = detectProvider();
  if (!provider) return null;
  const caller = CALLERS[provider];
  if (!caller) return null;
  try {
    const raw = await withTimeout(caller({ system, prompt }), timeoutMs);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch (err) {
    console.warn(`[aiGateway] provedor "${provider}" falhou: ${err.message}`);
    return null;
  }
}

module.exports = { isAvailable, detectProvider, extractJSON, complete };
