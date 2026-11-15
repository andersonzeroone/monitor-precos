import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, extractFromHtml } from '../src/scraper.js';

test('parsePrice entende formatos brasileiros e internacionais', () => {
  const cases = [
    ['R$ 1.299,90', 1299.9],
    ['R$ 89,90', 89.9],
    ['1299.90', 1299.9],
    ['1,299.90', 1299.9],
    ['2.499', 2499],
    ['12.999.999,00', 12999999],
    ['1299,9', 1299.9],
    ['0.999', 1], // decimal, arredondado para centavos
    [1499, 1499],
    ['à vista R$ 3.199,00 no PIX', 3199],
    ['12x de R$ 108,25', 108.25],
    ['grátis', null],
    ['', null],
    [0, null],
  ];
  for (const [input, expected] of cases) assert.equal(parsePrice(input), expected, `entrada: ${input}`);
});

test('extrai preço e nome do JSON-LD', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Notebook X",
     "offers":{"@type":"Offer","price":"3499.90","priceCurrency":"BRL"}}]}
  </script></head><body></body></html>`;
  const r = extractFromHtml(html, 'https://loja.com/p/1');
  assert.equal(r.price, 3499.9);
  assert.equal(r.title, 'Notebook X');
});

test('JSON-LD com AggregateOffer usa lowPrice', () => {
  const html = `<script type="application/ld+json">[{"@type":"Product","name":"TV","offers":{"@type":"AggregateOffer","lowPrice":2199,"highPrice":2599}}]</script>`;
  assert.equal(extractFromHtml(html, 'https://loja.com/tv').price, 2199);
});

test('cai para meta tags quando não há JSON-LD', () => {
  const html = `<meta property="og:title" content="Fone Y"><meta property="product:price:amount" content="199.00">`;
  const r = extractFromHtml(html, 'https://loja.com/fone');
  assert.equal(r.price, 199);
  assert.equal(r.title, 'Fone Y');
});

test('seletor da Amazon tem prioridade sobre o JSON-LD', () => {
  const html = `<span id="productTitle"> Kindle </span>
    <div id="corePriceDisplay_desktop_feature_div"><span class="priceToPay"><span class="a-offscreen">R$ 449,10</span></span></div>
    <script type="application/ld+json">{"@type":"Product","offers":{"price":"999"}}</script>`;
  const r = extractFromHtml(html, 'https://www.amazon.com.br/dp/X');
  assert.equal(r.price, 449.1);
});

test('seletor CSS próprio do produto', () => {
  const html = `<div class="preco"><b>R$ 5.000,00</b></div><div class="preco-final">R$ 4.500,00</div>`;
  assert.equal(extractFromHtml(html, 'https://loja.com/x', '.preco-final').price, 4500);
  assert.throws(() => extractFromHtml(html, 'https://loja.com/x', '.nao-existe'), /não encontrou/);
});

test('link de afiliado do Mercado Livre: usa o card em destaque', () => {
  const card = (title, prev, frac, cents = '') => `
    <div class="poly-card"><div class="poly-card__content">
      <a class="poly-component__title">${title}</a>
      <s class="andes-money-amount andes-money-amount--previous"><span class="andes-money-amount__fraction">${prev}</span></s>
      <div class="poly-price__current"><span class="andes-money-amount">
        <span class="andes-money-amount__currency-symbol">R$</span>
        <span class="andes-money-amount__fraction">${frac}</span>${cents ? `<span class="andes-money-amount__cents">${cents}</span>` : ''}
      </span></div>
    </div></div>`;
  const html = `<meta property="og:title" content="TV 55 C6K - R$">
    ${card('TV 55 C6K', '3.699', '3.514', '05')}${card('TV 65 C6K', '4.699', '3.899')}`;
  const r = extractFromHtml(html, 'https://www.mercadolivre.com.br/social/afiliado?ref=x');
  assert.equal(r.price, 3514.05); // preço atual, não o riscado
  assert.equal(r.title, 'TV 55 C6K');

  // Se o produto do link não estiver entre os cards, não lê outro produto por engano.
  const other = html.replace('TV 55 C6K - R$', 'Geladeira X - R$');
  assert.throws(() => extractFromHtml(other, 'https://www.mercadolivre.com.br/social/afiliado'), /Preço não encontrado/);
});

test('erro claro quando não acha o preço ou há captcha', () => {
  assert.throws(() => extractFromHtml('<h1>Oi</h1>', 'https://loja.com/x'), /seletor CSS/);
  assert.throws(() => extractFromHtml('<form action="/errors/validateCaptcha"></form>', 'https://loja.com/x'), /bloqueou/);
});
