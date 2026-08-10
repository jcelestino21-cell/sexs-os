#!/bin/bash
# ============================================================================
# SexS OS — Script de Deploy Automático para Fly.io
# ============================================================================
# Este script faz TUDO automaticamente:
# 1. Instala o Fly.io CLI (se não tiver)
# 2. Faz login na sua conta
# 3. Cria o app no Fly.io
# 4. Cria o volume para o banco de dados
# 5. Configura as variáveis
# 6. Faz o deploy
#
# COMO USAR:
#   No seu computador, abra o Terminal (Mac) ou PowerShell (Windows) e rode:
#
#   Mac/Linux:
#     chmod +x deploy.sh && ./deploy.sh
#
#   Windows (PowerShell):
#     bash deploy.sh
#
# ============================================================================

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     SexS OS — Deploy para Fly.io        ║"
echo "║     Deploy automático em ~5 minutos     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ---- 1. Verificar se o flyctl está instalado ----
if ! command -v flyctl &> /dev/null; then
  echo "📦 Instalando Fly.io CLI..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install flyctl 2>/dev/null || curl -L https://fly.io/install.sh | sh
  elif [[ "$OSTYPE" == "linux"* ]]; then
    curl -L https://fly.io/install.sh | sh
    export PATH="$HOME/.fly/bin:$PATH"
  elif [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "win32" ]]; then
    powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
    export PATH="$PATH:/c/Users/$USER/.fly/bin"
  fi
  echo "✅ Fly.io CLI instalado!"
else
  echo "✅ Fly.io CLI já instalado: $(flyctl version 2>/dev/null | head -1)"
fi

# ---- 2. Login ----
echo ""
echo "🔐 Fazendo login no Fly.io..."
echo "   (O browser vai abrir para você autenticar)"
echo ""
flyctl auth login
echo "✅ Login realizado!"

# ---- 3. Criar o app ----
echo ""
APP_NAME="sexs-os"
echo "🚀 Criando app '$APP_NAME' no Fly.io..."

# Verificar se o app já existe
if flyctl status --app "$APP_NAME" &>/dev/null; then
  echo "   App '$APP_NAME' já existe, usando o existente."
else
  flyctl launch --name "$APP_NAME" --region gru --no-deploy --yes 2>/dev/null || \
  flyctl apps create "$APP_NAME" 2>/dev/null || true
  echo "✅ App criado!"
fi

# ---- 4. Criar volume persistente ----
echo ""
echo "💾 Criando volume para o banco de dados..."
if flyctl volumes list --app "$APP_NAME" 2>/dev/null | grep -q "sexsos_data"; then
  echo "   Volume já existe, usando o existente."
else
  flyctl volumes create sexsos_data --app "$APP_NAME" --region gru --size 1 --yes 2>/dev/null || \
  flyctl volumes create sexsos_data --app "$APP_NAME" --region gru --size 1
  echo "✅ Volume criado (1GB em São Paulo)!"
fi

# ---- 5. Configurar variáveis de ambiente ----
echo ""
echo "⚙️  Configurando variáveis de ambiente..."
flyctl secrets set \
  NODE_ENV=production \
  PORT=3000 \
  --app "$APP_NAME" 2>/dev/null || true
echo "✅ Variáveis configuradas!"

# ---- 6. Deploy ----
echo ""
echo "🚀 Fazendo deploy (pode levar 3-5 minutos na primeira vez)..."
echo ""
flyctl deploy --app "$APP_NAME" --yes

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         🎉 DEPLOY CONCLUÍDO! 🎉         ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║  Seu sistema está no ar em:              ║"
echo "║                                          ║"

# Pegar a URL
APP_URL=$(flyctl status --app "$APP_NAME" --json 2>/dev/null | grep -o '"https://[^"]*"' | head -1 | tr -d '"' || echo "https://$APP_NAME.fly.dev")
echo "║  $APP_URL"
echo "║                                          ║"
echo "║  Para criar a conta da CEO:              ║"
echo "║                                          ║"
echo "║  flyctl ssh console --app $APP_NAME"
echo "║                                          ║"
echo "║  Depois dentro do console:               ║"
echo "║  node scripts/create-ceo.js \\"
echo "║    \"Jessica\" \"ceo\" \"sua-senha-aqui\""
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Comandos úteis:"
echo "  flyctl logs --app $APP_NAME       # Ver logs"
echo "  flyctl status --app $APP_NAME     # Status do app"
echo "  flyctl open --app $APP_NAME       # Abrir no browser"
echo "  flyctl deploy --app $APP_NAME     # Fazer novo deploy"
echo ""
