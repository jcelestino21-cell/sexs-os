# SexS OS — Sistema Operacional Empresarial

Sistema de gestão para empresa de revenda de cosméticos com equipe executiva virtual, kits consignados, controle de estoque, financeiro e portal da revendedora.

## Requisitos

- **Node.js 22 ou superior** (usa `node:sqlite`, módulo nativo)
- Pacote `docx` para geração de documentos Word

## Instalação

```bash
# Clonar e instalar dependências
npm install

# Configurar variáveis de ambiente
cp .env.example .env
# Edite o .env com seus dados (veja comentários no arquivo)

# Criar dados de demonstração (opcional — só para desenvolvimento)
npm run seed

# Iniciar o servidor
npm start
```

O servidor estará disponível em `http://localhost:3000`.  
O health check fica em `http://localhost:3000/health`.

## Credenciais de demonstração

Após rodar `npm run seed`:

| Usuário | Senha | Papel |
|---------|-------|-------|
| `ceo` | `sexsos-demo-2026` | CEO |
| `diego` | `diego-demo-2026` | Operações |
| `marina` | `marina-demo-2026` | RH |
| `renata` | `renata-demo-2026` | Financeiro |
| `ricardo` | `ricardo-demo-2026` | Comercial |
| `theo` | `theo-demo-2026` | Marketing |
| `arthur` | `arthur-demo-2026` | Conselheiro |

## Estrutura do projeto

```
sexs-os/
├── server.js           # Entry point do servidor HTTP
├── db.js               # Conexão central com SQLite
├── schema.sql          # Schema completo do banco
├── package.json
├── .env.example        # Template de variáveis de ambiente
├── .gitignore
├── Dockerfile
├── src/                # Módulos de negócio
│   ├── router.js       # Router HTTP minimalista
│   ├── auth.js         # Autenticação (scrypt + sessões)
│   ├── authorization.js # Autorização por capacidade
│   ├── audit.js        # Trilha de auditoria
│   ├── pricing.js      # Motor de precificação
│   ├── costCalc.js     # CMV (custo médio ponderado)
│   ├── events.js       # Parsers de linguagem natural + IA
│   ├── aiGateway.js    # Gateway de IA (Anthropic/OpenAI/Gemini/Ollama)
│   ├── conversationMemory.js
│   ├── conversationalBrain.js
│   ├── proposalService.js # Motor genérico de propostas
│   ├── notificationService.js
│   ├── documentService.js
│   ├── docxGenerator.js
│   ├── companyService.js
│   ├── productService.js
│   ├── productDraftService.js
│   ├── stockIntents.js # Compra de estoque (Diego)
│   ├── resellerService.js # Contratação (Marina)
│   ├── kitService.js   # Kits consignados
│   ├── financeService.js # Financeiro (Renata)
│   ├── ordersService.js
│   ├── dashboardService.js
│   ├── commercialService.js # Comercial (Ricardo)
│   ├── marketingService.js # Marketing (Theo)
│   ├── advisorService.js # Conselheiro (Arthur)
│   ├── anaService.js   # Chefe de Gabinete (Ana)
│   └── councilService.js # Conselho Executivo
├── public/
│   └── index.html      # Frontend (SPA)
├── scripts/
│   ├── seed.js         # Dados de demonstração
│   ├── backup.js       # Backup do banco
│   ├── restore.js      # Restauração do banco
│   ├── setup-company.js # Dados legais da empresa
│   └── ui-check.js     # Testes E2E com Playwright
└── tests/
    └── *.test.js       # 85+ testes automatizados
```

## Variáveis de ambiente

Veja `.env.example` para a lista completa. As mais importantes:

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `PORT` | Porta do servidor | `3000` |
| `NODE_ENV` | `production` em deploy | `development` |
| `SEXSOS_ENABLE_DEMO_TOKEN` | Ativa token de demo na resposta | `false` |
| `SEXSOS_DB_PATH` | Caminho do SQLite | `data/sexsos.db` |
| `CORS_ORIGIN` | Origem permitida para CORS | `*` |
| `ANTHROPIC_API_KEY` | Chave da Anthropic (opcional) | — |
| `OPENAI_API_KEY` | Chave da OpenAI (opcional) | — |
| `GEMINI_API_KEY` | Chave do Gemini (opcional) | — |
| `OLLAMA_HOST` | Host do Ollama local (opcional) | — |

## Testes

```bash
npm test
```

## Backup e restauração

```bash
# Criar backup
npm run backup

# Restaurar a partir de um backup
npm run restore -- data/backups/sexsos-XXXX.db
```

## Docker

```bash
# Build
docker build -t sexs-os .

# Run
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -v $(pwd)/data:/app/data \
  sexs-os
```

## Segurança (Fase 10.5)

- **IS_DEMO_MODE fail-safe**: tokens de recuperação só visíveis com `SEXSOS_ENABLE_DEMO_TOKEN=true`
- **CORS configurável**: via `CORS_ORIGIN`
- **Content-Security-Policy**: proteção contra XSS
- **CSRF**: tokens em requisições stateful
- **Rate limiting**: geral (120 req/min) + login (5 tentativas / 5 min)
- **Escape de XSS**: função `esc()` em toda interpolação de texto humano
- **Health check**: `/health`, `/healthz`, `/ready`
- **Graceful shutdown**: SIGTERM/SIGINT tratados
- **HSTS**: ativado automaticamente em `NODE_ENV=production`

## IA (opcional)

O sistema funciona 100% offline sem nenhuma chave de API. Quando uma chave é configurada, a IA complementa o mecanismo offline de interpretação de linguagem natural — nunca substitui o código determinístico de negócio.
