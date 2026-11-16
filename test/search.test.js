import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, matchOffers, requiredWords, excludedWords, parseSources, applyPayment } from '../src/search.js';

const nextData = (data) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;

test('palavras obrigatórias: padrão são as da busca; números precisam estar soltos', () => {
  assert.deepEqual(requiredWords('', 'TCL 55C6K'), ['tcl', '55c6k']);
  assert.deepEqual(requiredWords('55, c6k', 'qualquer'), ['55', 'c6k']);
  assert.deepEqual(excludedWords('suporte, open box'), ['suporte', 'open box']);

  const offers = [
    { title: 'Smart TV Mini LED 55" TCL 4K 55C6K', price: 3309, store: 'A', url: 'a' },
    { title: 'Smart TV TCL 65 Polegadas QD-Mini LED C6K', price: 3999, store: 'B', url: 'b' },
    { title: 'Smart TV TCL 550 C6K', price: 100, store: 'C', url: 'c' }, // 550 não é 55
    { title: 'Suporte de parede para TV TCL 55 C6K', price: 89, store: 'D', url: 'd' },
    { title: 'Smart TV TCL 55" C6K (Recondicionado)', price: 2500, store: 'E', url: 'e' },
    { title: 'TV TCL 55 Polegadas C6K Promoção', price: 3200, store: 'F', url: 'f' },
  ];
  const found = matchOffers(offers, { query: 'tcl 55c6k', required: '55 c6k', excluded: 'suporte, recondicionado' });
  assert.deepEqual(found.map((o) => o.url), ['f', 'a']); // mais barata primeiro
});

test('preço mínimo descarta ofertas suspeitas e URLs repetidas contam uma vez', () => {
  const offers = [
    { title: 'TV C6K', price: 50, store: 'A', url: 'a' },
    { title: 'TV C6K', price: 3000, store: 'B', url: 'b' },
    { title: 'TV C6K', price: 3000, store: 'B', url: 'b' },
    { title: 'TV C6K', price: null, store: 'C', url: 'c' },
  ];
  assert.deepEqual(matchOffers(offers, { query: 'c6k', minPrice: 1000 }).map((o) => o.url), ['b']);

  // A mesma oferta pelo Buscapé e pelo Zoom aparece uma vez só.
  const twice = [
    { title: 'TV C6K', price: 3309, store: 'Fast Shop (via Buscapé)', url: 'https://www.buscape.com.br/tv' },
    { title: 'TV C6K', price: 3309, store: 'Fast Shop (via Zoom)', url: 'https://www.zoom.com.br/tv' },
  ];
  assert.equal(matchOffers(twice, { query: 'c6k' }).length, 1);
});

test('fontes: só ids conhecidos; vazio usa o padrão', () => {
  assert.deepEqual(parseSources('amazon, xpto,kabum,amazon'), ['amazon', 'kabum']);
  assert.deepEqual(parseSources(''), ['buscape', 'amazon', 'kabum']);
});

test('Buscapé/Zoom: lê o menor preço e a loja de cada produto do catálogo', () => {
  const html = nextData({
    props: {
      initialReduxState: {
        hits: {
          hits: [
            { type: 'product', name: 'Smart TV 55" TCL 55C6K', price: 3309, url: '/tv/smart-tv-55c6k', bestOffer: { merchantName: 'Fast Shop' } },
            { type: 'offer', name: 'TV LG C6 55', price: 6999, url: '/lead?oid=1', merchantName: 'Amazon', installments: { amount_months: 10, price: 699.9, total_value: 6999 } },
            { type: 'offer', name: 'TV X', price: 2549.15, url: '/lead?oid=2', merchantName: 'Magalu', installments: { amount_months: 10, price: 299.9, total_value: 2999 } },
            { type: 'banner', name: 'Anúncio' },
          ],
        },
      },
    },
  });
  assert.deepEqual(SOURCES.buscape.parse(html), [
    { title: 'Smart TV 55" TCL 55C6K', price: 3309, store: 'Fast Shop (via Buscapé)', url: 'https://www.buscape.com.br/tv/smart-tv-55c6k', installments: null },
    { title: 'TV LG C6 55', price: 6999, store: 'Amazon (via Buscapé)', url: 'https://www.buscape.com.br/lead?oid=1', installments: { count: 10, value: 699.9, total: 6999 } },
    // parcelado mais caro que o à vista: o comparador não chama de "sem juros"
    { title: 'TV X', price: 2549.15, store: 'Magalu (via Buscapé)', url: 'https://www.buscape.com.br/lead?oid=2', installments: null },
  ]);
});

test('Kabum: usa o preço à vista quando menor, mostra o vendedor e pula indisponíveis', () => {
  const html = nextData({
    props: {
      pageProps: {
        data: {
          catalogServer: {
            data: [
              { code: 1, name: 'TV 55C6K', price: 3894.19, priceWithDiscount: 3504.77, maxInstallment: '10x de R$ 389,41', sellerName: 'LOJAS COLOMBO', friendlyName: 'tv-55c6k', available: true },
              { code: 2, name: 'TV 55C6K', price: 3699, priceWithDiscount: 0, maxInstallment: '12x de R$ 350,00', sellerName: 'KaBuM!', friendlyName: 'tv', available: true },
              { code: 3, name: 'TV 55C6K', price: 3000, available: false },
            ],
          },
        },
      },
    },
  });
  const offers = SOURCES.kabum.parse(html);
  assert.equal(offers.length, 2);
  assert.deepEqual(offers[0], {
    title: 'TV 55C6K',
    price: 3504.77,
    store: 'Kabum (vendido por LOJAS COLOMBO)',
    url: 'https://www.kabum.com.br/produto/1/tv-55c6k',
    installments: { count: 10, value: 389.41, total: 3894.19 },
  });
  assert.equal(offers[1].store, 'Kabum');
  assert.equal(offers[1].price, 3699);
  assert.equal(offers[1].installments, null); // 12 × 350 = 4.200 ≠ 3.699: tem juros
});

test('forma de pagamento: parcelado usa o total sem juros e descarta quem não parcela', () => {
  const offers = [
    { title: 'A', price: 3309, store: 'A', url: 'a', installments: null },
    { title: 'B', price: 3504.77, store: 'B', url: 'b', installments: { count: 10, value: 389.41, total: 3894.19 } },
  ];
  assert.equal(applyPayment(offers, 'avista'), offers);
  assert.deepEqual(applyPayment(offers, 'parcelado').map((o) => [o.url, o.price]), [['b', 3894.19]]);
});

test('Amazon: lê título, preço (inteiro + centavos) e monta o link pelo ASIN', () => {
  const html = `
    <div data-component-type="s-search-result" data-asin="B0TEST1234">
      <h2><span>Smart TV TCL 55 Polegadas C6K</span></h2>
      <span class="a-price"><span class="a-offscreen"></span><span class="a-price-whole">3.499,</span><span class="a-price-fraction">90</span></span>
      <span>ou em até 12x de R$ 319,91R$319,91 sem juros</span>
    </div>
    <div data-component-type="s-search-result" data-asin="B0SEMPRECO"><h2>Sem preço</h2></div>`;
  const offers = SOURCES.amazon.parse(html);
  assert.deepEqual(offers[0], {
    title: 'Smart TV TCL 55 Polegadas C6K',
    price: 3499.9,
    store: 'Amazon',
    url: 'https://www.amazon.com.br/dp/B0TEST1234',
    installments: { count: 12, value: 319.91, total: 3838.92 },
  });
  assert.equal(offers[1].price, null);
});
