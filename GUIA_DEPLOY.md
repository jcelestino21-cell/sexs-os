# 🚀 Guia de Deploy — SexS OS na Railway (Grátis)

## O que você vai ter no final:
- Sistema no ar em um endereço tipo `https://sexs-os.railway.app`
- Banco de dados persistente (seus dados não se perdem)
- HTTPS automático (cadeado verde)
- Backup diário possível
- Custo: R$0/mês (plano free da Railway)

---

## ⚠️ ANTES DE COMEÇAR — Checklist de Segurança

Você precisa fazer estas coisas ANTES de colocar no ar com dados reais:

- [ ] **Remover o seed de demonstração** — não rodar `npm run seed` em produção
- [ ] **Trocar as senhas** — criar contas novas com senhas fortes (12+ caracteres)
- [ ] **Nunca versionar o arquivo `.env`** — ele contém segredos
- [ ] **Backup** — configurar backup do banco (instruções no final)

---

## PASSO 1 — Criar conta na Railway

1. Acesse **https://railway.app**
2. Clique em **"Start a New Project"**
3. Faça login com GitHub (mais fácil)
4. Escolha o plano **"Hobby"** (grátis — $5 de crédito/mês, suficiente para o SexS OS)

---

## PASSO 2 — Colocar o código no GitHub

1. Crie uma conta no **GitHub** se ainda não tiver: https://github.com
2. Clique no **"+"** no canto superior direito → **"New repository"**
3. Nome: `sexs-os` (ou o que preferir)
4. Marque **"Private"** (⚠️ importante — NÃO deixe público com dados reais)
5. Clique **"Create repository"**

Agora faça upload dos arquivos:

```bash
# No seu computador, dentro da pasta sexs-os:
cd sexs-os

# Inicializar git (se ainda não tiver)
git init
git add .
git commit -m "SexS OS - deploy inicial"

# Conectar ao GitHub
git remote add origin https://github.com/SEU_USUARIO/sexs-os.git
git branch -M main
git push -u origin main
```

> **Dica:** Se preferir, pode fazer upload direto pelo site do GitHub arrastando os arquivos.

---

## PASSO 3 — Criar o projeto na Railway

1. Na Railway, clique em **"+ New Project"**
2. Escolha **"Deploy from GitHub Repo"**
3. Selecione o repositório `sexs-os`
4. A Railway vai detectar automaticamente que é Node.js

---

## PASSO 4 — Configurar as variáveis de ambiente

Na Railway, vá em **"Variables"** (ícone de variáveis no painel do serviço) e adicione:

| Variável | Valor | Por quê |
|----------|-------|---------|
| `NODE_ENV` | `production` | Ativa modo produção (segurança máxima) |
| `PORT` | `3000` | Porta do servidor |
| `CORS_ORIGIN` | `*` | Permite acesso (ajuste depois para seu domínio) |
| `SEXSOS_DB_PATH` | `/app/data/sexsos.db` | Caminho do banco no volume |

> ⚠️ **NÃO** adicione `SEXSOS_ENABLE_DEMO_TOKEN` em produção — isso é só para desenvolvimento local.

---

## PASSO 5 — Adicionar volume persistente (CRÍTICO!)

Sem isso, seus dados se perdem toda vez que o container reinicia.

1. No painel do serviço, vá em **"Volumes"**
2. Clique em **"+ Add Volume"**
3. Configure:
   - **Mount Path:** `/app/data`
   - **Name:** `sexsos-data`
4. Salve

Isso cria um disco persistente de 1GB (grátis) onde o banco SQLite fica salvo.

---

## PASSO 6 — Deploy!

1. A Railway faz deploy automaticamente a cada push no GitHub
2. Aguarde ~2 minutos
3. Quando o status ficar **"Success"**, clique em **"Generate Domain"** para criar um endereço público
4. Pronto! Acesse `https://seu-projeto.railway.app`

---

## PASSO 7 — Criar sua conta de CEO

No primeiro acesso, você precisa criar a conta da CEO. Execute localmente:

```bash
# No seu computador (NÃO no servidor):
cd sexs-os
node -e "
const db = require('./db');
const crypto = require('node:crypto');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('SUA_SENHA_FORTE_AQUI', salt, 64).toString('hex');
db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)').run('CEO', 'ceo', 'ceo', hash, salt);
console.log('✅ Conta CEO criada!');
"
```

> Depois faça backup desse banco e envie para o volume da Railway (via Railway CLI ou interface).

**Alternativa mais simples:** Configure temporariamente `SEXSOS_ENABLE_DEMO_TOKEN=true` na Railway, rode o seed, faça login, troque a senha, e depois remova a variável.

---

## PASSO 8 — Configurar domínio próprio (opcional)

Se quiser um endereço tipo `sistema.sexs.com.br`:

1. Na Railway, vá em **Settings → Domains → Custom Domain**
2. Digite seu domínio: `sistema.sexs.com.br`
3. No painel do seu domínio (Registro.br, GoDaddy, etc.), adicione:
   - **Tipo:** CNAME
   - **Nome:** sistema
   - **Valor:** o endereço que a Railway mostrar

---

## BACKUP — Como não perder seus dados

### Backup manual (via Railway CLI):
```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Baixar o banco
railway run bash -c "cat /app/data/sexsos.db" > backup-$(date +%Y-%m-%d).db
```

### Backup automático (script na Railway Cron):
1. Na Railway, crie um novo serviço **"Cron Job"**
2. Configure para rodar diariamente
3. O script copia o banco para um storage externo

---

## LIMITAÇÕES DO PLANO FREE DA RAILWAY

| Item | Limite Free | Suficiente para SexS OS? |
|------|-------------|--------------------------|
| Uso de CPU | 500 horas/mês | ✅ Sim (para 1-10 usuários) |
| RAM | 512 MB | ✅ Sim |
| Disco (volume) | 1 GB | ✅ Sim |
| Dormência | Após 7 dias sem uso | ⚠️ Acorda em ~30s |
| Domínios | 1 custom domain | ✅ Sim |

> Se o sistema "dormir" por falta de uso, o primeiro acesso demora ~30 segundos para acordar. Depois funciona normal.

---

## ALTERNATIVA: Render.com

Se preferir a Render (também grátis):

1. Acesse **https://render.com** → crie conta
2. **"New → Web Service"** → conecte o GitHub
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** `NODE_ENV=production`
4. Adicione disco persistente em **Settings → Disks** (500MB grátis)

---

## SUPORTE E DÚVIDAS

Se tiver qualquer problema no deploy, me pergunte aqui que eu ajudo a resolver!
