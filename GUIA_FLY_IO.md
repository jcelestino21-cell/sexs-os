# 🚀 Guia de Deploy — SexS OS no Fly.io

## Resultado final:
- Sistema no ar em `https://sexs-os.fly.dev`
- Banco SQLite persistente (volume de 1GB)
- HTTPS automático
- Servidor em **São Paulo** (latência ~10ms)
- Custo: **US$0/mês** dentro do free tier

---

## O QUE VOCÊ PRECISA ANTES DE COMEÇAR

- Um computador com terminal (Windows: PowerShell, Mac: Terminal)
- Conta no Fly.io: **https://fly.io/app/sign-up** (grátis, pede cartão mas não cobra)
- Conta no GitHub: **https://github.com**

---

## PASSO 1 — Instalar o flyctl (ferramenta de deploy)

**Windows (PowerShell):**
```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

**Mac:**
```bash
brew install flyctl
```

**Linux:**
```bash
curl -L https://fly.io/install.sh | sh
```

Depois faça login:
```bash
fly auth login
```
Vai abrir o navegador para confirmar a conta.

---

## PASSO 2 — Subir o código para o GitHub

```bash
cd sexs-os
git init
git add .
git commit -m "SexS OS - deploy inicial"
```

No GitHub, crie um repositório **PRIVADO** chamado `sexs-os` e depois:
```bash
git remote add origin https://github.com/SEU_USUARIO/sexs-os.git
git branch -M main
git push -u origin main
```

---

## PASSO 3 — Criar o app no Fly.io

Dentro da pasta `sexs-os`, rode:

```bash
fly launch
```

Ele vai fazer perguntas:
| Pergunta | Resposta |
|----------|----------|
| Choose an app name | `sexs-os` (ou o que quiser) |
| Choose a region | `gru` (São Paulo) |
| Would you like to set up a Postgresql database? | **No** |
| Would you like to set up an Upstash Redis database? | **No** |
| Would you like to deploy now? | **No** (vamos configurar o volume primeiro) |

---

## PASSO 4 — Criar o volume persistente (CRÍTICO!)

Sem isso, seus dados se perdem quando a máquina reinicia:

```bash
fly volumes create sexsos_data --region gru --size 1
```

- `sexsos_data` = nome do volume (deve bater com `fly.toml`)
- `--region gru` = São Paulo (mesma região do app)
- `--size 1` = 1 GB (suficiente para anos de operação)

---

## PASSO 5 — Configurar as variáveis de ambiente (secrets)

```bash
fly secrets set NODE_ENV=production
fly secrets set PORT=3000
```

> ⚠️ **NÃO** coloque `SEXSOS_ENABLE_DEMO_TOKEN` — isso é só para desenvolvimento local.

---

## PASSO 6 — Deploy!

```bash
fly deploy
```

Aguarde ~3-5 minutos (primeiro deploy compila o Docker). Quando terminar:

```bash
fly open
```

Abre o navegador direto no sistema. 🎉

---

## PASSO 7 — Criar sua conta de CEO

Execute **dentro da máquina do Fly.io**:

```bash
fly ssh console
```

Dentro do console, rode:
```bash
node -e "
const db = require('./db');
const crypto = require('node:crypto');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('SUA_SENHA_FORTE_AQUI_MINIMO_12_CARACTERES', salt, 64).toString('hex');
db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)').run('Jessica', 'ceo', 'ceo', hash, salt);
console.log('Conta CEO criada!');
"
```

Depois saia do console com `exit` e acesse o sistema com seu login e senha.

---

## PASSO 8 — Contratar suas revendedoras

1. Faça login como CEO no sistema
2. Fale com a **Marina** na Central:
   > "Contratamos Patrícia, telefone 11988887777, endereço Rua X, 123"
3. A proposta aparece → clique **Aprovar**
4. Copie o **link de primeiro acesso** que aparece
5. Envie para a revendedora por WhatsApp
6. Ela acessa o link e cria a própria senha

---

## COMANDOS ÚTEIS DO FLY.IO

| Comando | O que faz |
|---------|-----------|
| `fly status` | Ver se o app está rodando |
| `fly logs` | Ver logs do servidor em tempo real |
| `fly ssh console` | Acessar o terminal da máquina |
| `fly deploy` | Fazer novo deploy (após mudanças) |
| `fly open` | Abrir o sistema no navegador |
| `fly scale count 0` | Desligar (parar de usar créditos) |
| `fly scale count 1` | Ligar de novo |

---

## BACKUP DO BANCO

Para baixar o banco do servidor:

```bash
# Conectar via SSH e copiar o arquivo
fly ssh console -C "cat /app/data/sexsos.db" > backup-$(date +%Y-%m-%d).db
```

Para restaurar:
```bash
fly ssh console -C "cat > /app/data/sexsos.db" < backup-2026-08-06.db
```

---

## DOMÍNIO PRÓPRIO (opcional)

Para usar `sistema.sexs.com.br`:

```bash
fly certs add sistema.sexs.com.br
```

Depois no painel do seu domínio (Registro.br):
- **Tipo:** CNAME
- **Nome:** sistema
- **Valor:** `sexs-os.fly.dev`

---

## PLANO FREE DO FLY.IO — O QUE ESTÁ INCLUSO

| Recurso | Limite Free |
|---------|-------------|
| Máquinas virtuais | Até 3 shared-cpu-1x |
| RAM | 256 MB por máquina |
| Volumes | 1 GB total |
| Transferência | 100 GB/mês (saída) |
| IPv4 | 1 endereço dedicado |

> **Dica:** Com `auto_stop_machines` ativado no fly.toml, a máquina desliga quando ninguém usa e liga sozinha quando acessam. Isso economiza muito os créditos.

---

## SE DER ALGUM ERRO

| Problema | Solução |
|----------|---------|
| `fly deploy` falha no build | Rode `fly logs` para ver o erro. Geralmente é dependência faltando. |
| Sistema não abre | `fly status` mostra se a máquina está rodando. `fly logs` mostra erros. |
| Dados sumiram | Verifique se o volume foi criado: `fly volumes list` |
| "Cannot find module" | `fly ssh console` → `cd /app && npm install` |
| Login não funciona | Verifique se criou a conta CEO (Passo 7) |

Me pergunte aqui se travar em qualquer passo!
