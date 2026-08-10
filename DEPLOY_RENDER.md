# 🚀 Deploy no Render.com (sem cartão de crédito)

## Passo 1: Subir o código para o GitHub

1. Crie conta no GitHub: https://github.com (se não tiver)
2. Crie um novo repositório **PRIVADO** chamado `sexs-os`
3. No terminal, dentro da pasta sexs-os:

```bash
cd sexs-os
git init
git add .
git commit -m "SexS OS - deploy inicial"
git remote add origin https://github.com/SEU_USUARIO/sexs-os.git
git branch -M main
git push -u origin main
```

## Passo 2: Criar conta no Render

1. Acesse: https://render.com
2. Clique em **"Get Started"** → faça login com GitHub
3. Autorize o Render a acessar seus repositórios

## Passo 3: Criar o Web Service

1. No dashboard, clique em **"New +"** → **"Web Service"**
2. Conecte seu repositório `sexs-os`
3. Preencha:

| Campo | Valor |
|-------|-------|
| **Name** | `sexs-os` |
| **Region** | `Oregon` (ou o mais próximo) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | `Free` |

4. Adicione estas **Environment Variables**:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |

5. Clique em **"Create Web Service"**

## Passo 4: Aguardar o deploy (~3-5 min)

O Render vai automaticamente:
- ✅ Instalar dependências
- ✅ Iniciar o servidor
- ✅ Gerar uma URL pública

## Passo 5: Criar conta da CEO

Como o Render free não tem terminal SSH, acesse o **Shell** pelo dashboard:
1. No painel do serviço → **"Shell"**
2. Rode: `node scripts/create-ceo.js "Jessica" "ceo" "SuaSenhaForte123"`

## ⚠️ Importante sobre o plano Free do Render

- O serviço "adormece" após 15 min sem uso (acorda em ~30s)
- **Os dados no banco são perdidos quando o serviço reinicia** (a cada ~24h)
- Para ter dados persistentes, faça upgrade para o plano Individual ($7/mês) que inclui disco

### Alternativa: Adicionar disco persistente ($1/mês)
1. No painel do serviço → **"Disks"** → **"Add Disk"**
2. Name: `sexsos-data`, Mount Path: `/app/data`, Size: `1 GB`
3. Isso custa ~$1/mês e mantém seus dados seguros
