const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

  const log = (...args) => console.log(...args);

  await page.goto('http://localhost:3000/');
  log('1. Página carregou:', await page.title());

  // Login como CEO
  await page.fill('#username', 'ceo');
  await page.fill('#password', 'sexsos-demo-2026');
  await page.click('#loginBtn');
  await page.waitForSelector('.tabs', { timeout: 5000 });
  log('2. Login CEO ok, tabs visíveis');

  await page.click('[data-tab="chat"]');
  await page.waitForSelector('#msgInput');
  log('2b. Aba Central aberta');

  await page.click('.director[data-key="diego"]');
  await page.waitForTimeout(200);

  // Enviar mensagem de compra para Diego
  await page.waitForSelector('#msgInput');
  await page.fill('#msgInput', 'Comprei 40 unidades do Gel Premium por R$ 10 cada, do fornecedor Beta.');
  await page.click('#sendBtn');
  await page.waitForSelector('.proposal-card', { timeout: 5000 });
  log('3. Proposta de compra apareceu no chat');

  await page.click('.proposal-card button.approve');
  await page.waitForTimeout(500);
  const statusText = await page.textContent('.proposal-status');
  log('4. Status após aprovar compra:', statusText.trim());

  // Ir para aba Estoque e conferir saldo
  await page.click('[data-tab="stock"]');
  await page.waitForTimeout(300);
  const stockTable = await page.textContent('#view-stock');
  log('5. Aba Estoque contém "Gel Premium"?', stockTable.includes('Gel Premium'));

  // Contratar revendedora via Marina
  await page.click('[data-tab="chat"]');
  await page.waitForTimeout(200);
  await page.click('.director[data-key="marina"]');
  await page.waitForTimeout(300);
  await page.fill('#msgInput', 'Contratamos Joana, telefone 11988887777, endereço Av Central, 500.');
  await page.click('#sendBtn');
  await page.waitForSelector('.proposal-card', { timeout: 5000 });
  log('6. Proposta de contratação apareceu no chat');
  await page.click('.proposal-card button.approve');
  await page.waitForTimeout(500);
  const calloutVisible = await page.locator('.callout').count();
  log('7. Link de primeiro acesso exibido?', calloutVisible > 0);
  let firstAccessLink = null;
  if (calloutVisible > 0) {
    firstAccessLink = await page.textContent('.link-token');
    log('   link:', firstAccessLink.trim());
  }

  // Aba Revendedoras
  await page.click('[data-tab="resellers"]');
  await page.waitForTimeout(300);
  const resellersHtml = await page.textContent('#view-resellers');
  log('8. Aba Revendedoras contém "Joana"?', resellersHtml.includes('Joana'));

  // Aba Kits: sugerir kit
  await page.click('[data-tab="kits"]');
  await page.waitForTimeout(300);
  await page.selectOption('#kitReseller', { label: 'Joana' });
  await page.selectOption('#kitProduct', { index: 0 });
  await page.fill('#kitQty', '15');
  await page.click('#suggestKitBtn');
  await page.waitForSelector('.kit-card', { timeout: 5000 });
  log('9. Kit sugerido apareceu na aba Kits');

  await page.click('.kit-card button[data-action="approve"]');
  await page.waitForTimeout(500);
  log('10. Kit aprovado (clicou em Aprovar)');

  await page.click('.kit-card button[data-action="confirm-delivery"]');
  await page.waitForTimeout(500);
  const kitCardText = await page.textContent('.kit-card');
  log('11. Kit entregue? status atual:', kitCardText.includes('entregue'));

  // Logout e login como a revendedora (via link de primeiro acesso)
  await page.click('#logoutBtn');
  await page.waitForSelector('.login-wrap', { timeout: 5000 });
  log('12. Logout OK, tela de login exibida');

  if (firstAccessLink) {
    const tokenPath = firstAccessLink.trim().split('/#primeiro-acesso/')[1];
    await page.goto('http://localhost:3000/#primeiro-acesso/' + tokenPath);
    await page.waitForSelector('#faPassword', { timeout: 5000 });
    await page.fill('#faPassword', 'joana-senha-123');
    page.once('dialog', (d) => d.accept());
    await page.click('#faBtn');
    await page.waitForSelector('.login-wrap', { timeout: 5000 });
    log('13. Primeiro acesso concluído, voltou para tela de login');

    await page.fill('#username', 'joana');
    await page.fill('#password', 'joana-senha-123');
    await page.click('#loginBtn');
    await page.waitForSelector('.kit-card, .empty', { timeout: 5000 });
    log('14. Login da revendedora Joana ok, portal carregado');

    const portalHtml = await page.textContent('#portal-mykits');
    log('15. Portal mostra o kit entregue?', portalHtml.includes('entregue'));

    // Informar venda
    const qtyInputs = await page.locator('input[id^="qty-"]').count();
    if (qtyInputs > 0) {
      await page.fill('input[id^="qty-"]', '5');
      await page.click('button[data-item]');
      await page.waitForTimeout(500);
      const portalAfter = await page.textContent('#portal-mykits');
      log('16. Venda informada, disponível atualizado:', portalAfter.includes('disponível 10'));
    }

    await page.click('[data-tab="ranking"]');
    await page.waitForTimeout(300);
    const rankingHtml = await page.textContent('#portal-ranking');
    log('17. Ranking do portal (sem nomes de outras):', rankingHtml.replace(/\s+/g, ' ').trim());
  } else {
    log('13-17. PULADO: sem link de primeiro acesso capturado.');
  }

  log('\n=== ERROS DE CONSOLE/PÁGINA CAPTURADOS ===');
  log(errors.length === 0 ? 'Nenhum.' : errors.join('\n'));

  await browser.close();
})().catch((e) => { console.error('FALHA NO SCRIPT:', e); process.exit(1); });
