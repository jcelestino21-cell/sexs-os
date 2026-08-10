// ==========================================================================
// SexS OS — Backup & Restore Automático via GitHub Gist
// ==========================================================================
// Salva backups do banco SQLite como Gists privados no GitHub.
// Na inicialização, se o banco estiver vazio, restaura do último backup.
//
// Configuração (variáveis de ambiente):
//   GITHUB_TOKEN     — Token do GitHub com escopo "gist"
//   GITHUB_USER      — Username do GitHub (ex: jcelestino21-cell)
//   BACKUP_GIST_ID   — ID do Gist de backup (criado automaticamente na primeira vez)
//   BACKUP_INTERVAL  — Intervalo em minutos entre backups (padrão: 30)
//   NOTIFY_EMAIL     — Email para notificações (opcional)
// ==========================================================================
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execSync } = require('node:child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.SEXSOS_DB_PATH || path.join(DATA_DIR, 'sexsos.db');
const BACKUP_STATE_FILE = path.join(DATA_DIR, '.backup-state.json');
const BACKUP_INTERVAL_MS = (parseInt(process.env.BACKUP_INTERVAL) || 5) * 60 * 1000;

// ---- GitHub API helpers ----

function githubRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN não configurado'));

    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SexS-OS-Backup',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---- Backup ----

function createDatabaseDump() {
  // Criar dump SQL do banco SQLite
  if (!fs.existsSync(DB_PATH)) return null;

  try {
    // Copia o arquivo do banco para um temp (backup seguro sem lock)
    const tempPath = DB_PATH + '.backup-temp';
    fs.copyFileSync(DB_PATH, tempPath);

    // Ler o arquivo copiado como base64
    const content = fs.readFileSync(tempPath);
    fs.unlinkSync(tempPath);

    return {
      binary: content.toString('base64'),
      size: content.length,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[Backup] Erro ao criar dump:', e.message);
    return null;
  }
}

async function saveBackupToGist(dump) {
  const gistId = process.env.BACKUP_GIST_ID || loadBackupState().gistId;
  const MAX_BACKUPS = 5;

  const fileName = `sexsos-backup-${dump.timestamp.replace(/[:.]/g, '-')}.db.b64`;
  const metadata = JSON.stringify({
    timestamp: dump.timestamp,
    size_bytes: dump.size,
    version: '1.0',
    app: 'sexs-os',
  }, null, 2);

  // Se existe gist, buscar arquivos atuais e limpar antigos
  let existingFiles = {};
  if (gistId) {
    try {
      const current = await githubRequest('GET', `/gists/${gistId}`);
      if (current.status === 200) {
        existingFiles = current.data.files || {};
        // Identificar backups antigos para remover
        const backupNames = Object.keys(existingFiles).filter(f => f.endsWith('.db.b64')).sort();
        const toRemove = backupNames.length >= MAX_BACKUPS ? backupNames.slice(0, backupNames.length - MAX_BACKUPS + 1) : [];
        for (const old of toRemove) {
          existingFiles[old] = null; // null = deletar arquivo do gist
          console.log(`[Backup] 🗑️ Removendo backup antigo: ${old}`);
        }
      }
    } catch (e) {
      console.error('[Backup] Erro ao buscar gist atual:', e.message);
    }
  }

  const files = {
    ...existingFiles,
    [fileName]: { content: dump.binary },
    'backup-info.json': { content: metadata },
  };

  try {
    if (gistId) {
      // Atualizar Gist existente
      const result = await githubRequest('PATCH', `/gists/${gistId}`, { files });
      if (result.status === 200) {
        console.log(`[Backup] ✅ Gist atualizado: ${gistId} (${(dump.size / 1024).toFixed(1)} KB)`);
        saveBackupState({ gistId, lastBackup: dump.timestamp, size: dump.size });
        return true;
      }
      console.error(`[Backup] Erro ao atualizar Gist: ${result.status}`, result.data);
    }

    // Criar novo Gist
    const result = await githubRequest('POST', '/gists', {
      description: 'SexS OS — Database Backup (automático)',
      public: false,
      files,
    });

    if (result.status === 201) {
      const newGistId = result.data.id;
      console.log(`[Backup] ✅ Novo Gist criado: ${newGistId} (${(dump.size / 1024).toFixed(1)} KB)`);
      saveBackupState({ gistId: newGistId, lastBackup: dump.timestamp, size: dump.size });
      // Salvar o GIST ID nas env vars para próximas vezes
      console.log(`[Backup] 📝 Adicione BACKUP_GIST_ID=${newGistId} nas variáveis de ambiente do Render`);
      return true;
    }
    console.error(`[Backup] Erro ao criar Gist: ${result.status}`, result.data);
    return false;
  } catch (e) {
    console.error('[Backup] Erro:', e.message);
    return false;
  }
}


// ---- Backup por Email ----
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || 'sexssexshop@gmail.com';

async function sendBackupEmail(dump, gistUrl) {
  try {
    // Resumo dos dados para o email
    let summary = '';
    try {
      const products = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
      const resellers = db.prepare('SELECT COUNT(*) as c FROM resellers').get().c;
      const kits = db.prepare('SELECT COUNT(*) as c FROM kits WHERE status NOT IN (\'rejeitado\')').get().c;
      const stock = db.prepare('SELECT COALESCE(SUM(quantity),0) as s FROM stock_movements').get().s;
      summary = `Produtos: ${products} | Revendedoras: ${resellers} | Kits ativos: ${kits} | Mov. estoque: ${stock}`;
    } catch(e) { summary = 'Erro ao gerar resumo'; }

    const subject = `[SexS OS] Backup ${new Date().toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo'})}`;
    const message = `Backup automático SexS OS\n\n` +
      `📅 Data: ${dump.timestamp}\n` +
      `📦 Tamanho: ${(dump.size / 1024).toFixed(1)} KB\n` +
      `📊 ${summary}\n\n` +
      `🔗 Gist: ${gistUrl || 'não disponível'}\n\n` +
      `Para restaurar, use o link do Gist acima ou o arquivo anexado.\n\n` +
      `---\nBackup base64 (copie e salve como .b64):\n${dump.binary.substring(0, 500)}...`;

    // Enviar via FormSubmit.co (gratuito, sem autenticação)
    const https = require('https');
    const postData = JSON.stringify({
      _subject: subject,
      message: message,
      _template: 'box',
      _captcha: 'false'
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'formsubmit.co',
        path: `/ajax/${BACKUP_EMAIL}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          console.log(`[Backup] 📧 Email enviado para ${BACKUP_EMAIL} (${res.statusCode})`);
          resolve(true);
        });
      });
      req.on('error', (e) => { console.error('[Backup] 📧 Erro email:', e.message); resolve(false); });
      req.write(postData);
      req.end();
    });
  } catch (e) {
    console.error('[Backup] 📧 Erro:', e.message);
    return false;
  }
}

// ---- Restore ----

async function restoreFromGist() {
  const gistId = process.env.BACKUP_GIST_ID || loadBackupState().gistId;
  if (!gistId) {
    console.log('[Restore] Nenhum Gist de backup configurado.');
    return false;
  }

  try {
    console.log(`[Restore] Buscando backup do Gist ${gistId}...`);
    const result = await githubRequest('GET', `/gists/${gistId}`);
    if (result.status !== 200) {
      console.error(`[Restore] Erro ao buscar Gist: ${result.status}`);
      return false;
    }

    // Encontrar o arquivo de backup mais recente (o .db.b64)
    const files = result.data.files;
    const backupFiles = Object.keys(files).filter(f => f.endsWith('.db.b64')).sort().reverse();

    if (backupFiles.length === 0) {
      console.log('[Restore] Nenhum arquivo de backup encontrado no Gist.');
      return false;
    }

    const latestFile = backupFiles[0];
    const base64Content = files[latestFile].content;
    const buffer = Buffer.from(base64Content, 'base64');

    // Garantir que o diretório existe
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // Salvar o banco restaurado
    fs.writeFileSync(DB_PATH, buffer);

    const info = files['backup-info.json'] ? JSON.parse(files['backup-info.json'].content) : {};
    console.log(`[Restore] ✅ Banco restaurado com sucesso!`);
    console.log(`[Restore]    Arquivo: ${latestFile}`);
    console.log(`[Restore]    Tamanho: ${(buffer.length / 1024).toFixed(1)} KB`);
    console.log(`[Restore]    Data do backup: ${info.timestamp || 'desconhecida'}`);
    return true;
  } catch (e) {
    console.error('[Restore] Erro:', e.message);
    return false;
  }
}

// ---- Estado local ----

function loadBackupState() {
  try {
    if (fs.existsSync(BACKUP_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(BACKUP_STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveBackupState(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const existing = loadBackupState();
    fs.writeFileSync(BACKUP_STATE_FILE, JSON.stringify({ ...existing, ...state }, null, 2));
  } catch (e) {}
}

// ---- Agendamento ----

let backupTimer = null;

async function performBackup() {
  if (!fs.existsSync(DB_PATH)) return;

  const dump = createDatabaseDump();
  if (!dump) return;

  let gistUrl = '';
  if (process.env.GITHUB_TOKEN) {
    const saved = await saveBackupToGist(dump);
    if (saved) {
      const gistId = process.env.BACKUP_GIST_ID || loadBackupState().gistId;
      gistUrl = gistId ? `https://gist.github.com/${gistId}` : '';
    }
  }

  // Enviar email a cada 5 minutos (independente do Gist)
  await sendBackupEmail(dump, gistUrl);
}

function startBackupScheduler() {
  if (!process.env.GITHUB_TOKEN) {
    console.log('[Backup] ⚠️  GITHUB_TOKEN não configurado — backups automáticos desativados.');
    return;
  }

  console.log(`[Backup] 🕐 Backups automáticos a cada ${BACKUP_INTERVAL_MS / 60000} minutos`);

  // Fazer backup imediato na inicialização (depois de 1 minuto)
  setTimeout(() => performBackup(), 60000);

  // Agendar backups periódicos
  backupTimer = setInterval(() => performBackup(), BACKUP_INTERVAL_MS);
  if (backupTimer.unref) backupTimer.unref(); // Não impede o processo de encerrar
}

// ---- Verificar se precisa restaurar na inicialização ----

async function autoRestoreIfNeeded() {
  // Se o banco já existe e tem dados, não restaurar
  if (fs.existsSync(DB_PATH)) {
    const stats = fs.statSync(DB_PATH);
    if (stats.size > 0) {
      // Verificar se tem tabelas (banco não vazio)
      try {
        const db = require('../db');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (tables.length > 5) {
          console.log('[Restore] Banco existente com dados — restore desnecessário.');
          return;
        }
      } catch (e) {}
    }
  }

  // Banco não existe ou está vazio — tentar restaurar
  if (process.env.GITHUB_TOKEN && (process.env.BACKUP_GIST_ID || loadBackupState().gistId)) {
    console.log('[Restore] 📦 Banco vazio ou ausente — tentando restaurar do último backup...');
    const restored = await restoreFromGist();
    if (!restored) {
      console.log('[Restore] Nenhum backup disponível — iniciando com banco novo.');
    }
  }
}

// ---- Graceful shutdown: backup antes de encerrar ----

function setupShutdownBackup() {
  const doShutdownBackup = async (signal) => {
    console.log(`[Backup] 🛑 ${signal} recebido — fazendo backup de emergência...`);
    try {
      await performBackup();
    } catch (e) {
      console.error('[Backup] Erro no backup de emergência:', e.message);
    }
  };

  process.on('SIGTERM', () => { doShutdownBackup('SIGTERM'); });
  process.on('SIGINT', () => { doShutdownBackup('SIGINT'); });
}

module.exports = {
  performBackup,
  restoreFromGist,
  autoRestoreIfNeeded,
  startBackupScheduler,
  setupShutdownBackup,
};
