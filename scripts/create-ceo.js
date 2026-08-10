// Script para criar a conta da CEO com senha forte.
// Uso: node scripts/create-ceo.js "Nome da CEO" "username" "senha-forte-aqui"
//
// ⚠️ RODE APENAS UMA VEZ, no primeiro setup do sistema.
// A senha nunca é armazenada em texto puro — só o hash scrypt.
const db = require('../db');
const crypto = require('node:crypto');

const [,, name, username, password] = process.argv;

if (!name || !username || !password) {
  console.log('Uso: node scripts/create-ceo.js "Nome" "username" "senha"');
  console.log('Exemplo: node scripts/create-ceo.js "Jessica" "ceo" "m1nh4-S3nha-F0rt3!"');
  process.exit(1);
}

if (password.length < 12) {
  console.error('❌ A senha precisa ter pelo menos 12 caracteres para produção.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  console.error(`❌ Usuário "${username}" já existe.`);
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

db.prepare(
  'INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)'
).run(name, username, 'ceo', hash, salt);

console.log(`✅ Conta CEO criada com sucesso!`);
console.log(`   Nome: ${name}`);
console.log(`   Login: ${username}`);
console.log(`   Senha: ${'*'.repeat(password.length)} (não é armazenada em texto puro)`);
console.log('');
console.log('Agora faça login no sistema com essas credenciais.');
console.log('⚠️  Não compartilhe esta senha com ninguém.');
