process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDocx } = require('../src/docxGenerator');

test('gera um arquivo .docx real (assinatura de ZIP/Office), não texto puro', async () => {
  const buffer = await generateDocx({ id: 1, type: 'contrato', content: 'CONTRATO DE TESTE\n\nLinha um.\nLinha dois.' });
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000); // um .docx de verdade nunca é minúsculo
  // .docx é um ZIP — os primeiros bytes são a assinatura "PK" de arquivo ZIP.
  assert.equal(buffer[0], 0x50); // 'P'
  assert.equal(buffer[1], 0x4B); // 'K'
});

test('gera documento para cada tipo suportado sem lançar erro', async () => {
  const types = ['contrato', 'ficha_cadastral', 'termo_ciencia', 'termo_entrega', 'fechamento'];
  for (const type of types) {
    const buffer = await generateDocx({ id: 1, type, content: 'Conteúdo de teste para ' + type });
    assert.ok(buffer.length > 500, `tipo ${type} deveria gerar um docx válido`);
  }
});
