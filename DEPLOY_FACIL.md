# 🚀 Deploy em 3 Passos — SexS OS no Fly.io

## Passo 1: Baixe o projeto

Faça download do arquivo `sexs-os.zip` que enviei e extraia no seu computador.

## Passo 2: Abra o Terminal

**Mac:**
1. Abra o app "Terminal"
2. Navegue até a pasta extraída:
```bash
cd ~/Downloads/sexs-os
```

**Windows:**
1. Abra o "PowerShell"
2. Navegue até a pasta extraída:
```powershell
cd $HOME\Downloads\sexs-os
```

## Passo 3: Rode o deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

O script vai automaticamente:
1. ✅ Instalar o Fly.io CLI (se precisar)
2. ✅ Abrir o browser para você fazer login
3. ✅ Criar o app em São Paulo
4. ✅ Criar volume para o banco (1GB)
5. ✅ Configurar variáveis
6. ✅ Fazer o deploy (~3-5 min)

No final, vai mostrar a URL do seu sistema no ar!

---

## Depois do Deploy: Criar conta da CEO

```bash
flyctl ssh console --app sexs-os
```

Dentro do console:
```bash
node scripts/create-ceo.js "Jessica" "ceo" "SuaSenhaForteAqui123"
exit
```

Pronto! Acesse a URL e faça login com `ceo` / `SuaSenhaForteAqui123`

---

## Comandos Úteis

| Comando | O que faz |
|---------|-----------|
| `flyctl status --app sexs-os` | Ver se está rodando |
| `flyctl logs --app sexs-os` | Ver logs em tempo real |
| `flyctl open --app sexs-os` | Abrir no browser |
| `flyctl deploy --app sexs-os` | Atualizar após mudanças |
| `flyctl ssh console --app sexs-os` | Acessar o terminal |

---

## Se der erro:

| Problema | Solução |
|----------|---------|
| `flyctl: command not found` | Rode: `export PATH="$HOME/.fly/bin:$PATH"` |
| `not authorized` | Rode: `flyctl auth login` |
| `app already exists` | Normal — o script usa o app existente |
| `volume already exists` | Normal — o script usa o volume existente |
| Deploy falha | Rode `flyctl logs --app sexs-os` e me mande o erro |
