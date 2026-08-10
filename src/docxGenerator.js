// Gera arquivos .docx REAIS a partir do conteúdo já preenchido em documentService.js
// (Correção Seção 11 — "não declare documento pronto quando existe só texto").
// O pacote 'docx' vem empacotado dentro de node_modules/ neste projeto (não precisa
// de `npm install` nem de internet) precisamente porque este ambiente de construção
// não tem acesso à rede — copiamos o pacote já resolvido, com suas dependências,
// para dentro do projeto.
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

const TYPE_TITLES = {
  contrato: 'Contrato de Revenda Consignada',
  ficha_cadastral: 'Ficha Cadastral de Revendedora',
  termo_ciencia: 'Termo de Ciência — Condições de Revenda Consignada',
  termo_entrega: 'Termo de Entrega / Consignação',
  fechamento: 'Documento de Fechamento de Kit',
};

/** O conteúdo salvo no banco é texto simples com quebras de linha (gerado em
 * documentService.js); aqui só formatamos isso como parágrafos de um .docx de
 * verdade, com um título proporcional ao tipo do documento. */
async function generateDocx(document) {
  const title = TYPE_TITLES[document.type] || 'Documento';
  const bodyLines = document.content.split('\n');

  const children = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ text: '' }),
  ];

  for (const line of bodyLines) {
    if (line.trim() === '') {
      children.push(new Paragraph({ text: '' }));
      continue;
    }
    // Linhas que já eram um "título" em maiúsculas no texto-fonte viram destaque leve.
    const isAllCaps = line === line.toUpperCase() && /[A-ZÀ-Ú]/.test(line);
    children.push(new Paragraph({
      children: [new TextRun({ text: line, bold: isAllCaps })],
      spacing: { after: 120 },
    }));
  }

  const doc = new Document({
    creator: 'SexS OS',
    title,
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generateDocx };
