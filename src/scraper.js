import * as cheerio from 'cheerio';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Seletores conhecidos para lojas que não expõem o preço em dados estruturados (ou expõem errado).
const SITE_SELECTORS = [
  {
    host: /(^|\.)amazon\./,
    selectors: [
      '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
      '#corePrice_feature_div .a-offscreen',
      '#corePrice_desktop .a-offscreen',
      '.priceToPay .a-offscreen',
      '#corePriceDisplay_desktop_feature_div .priceToPay',
      '#priceblock_dealprice',
      '#priceblock_ourprice',
      '#apex_desktop .a-price .a-offscreen',
    ],
  },
  {
    host: /(^|\.)mercadoli(vre|bre)\./,
    selectors: ['meta[itemprop="price"]'],
  },
];

const META_SELECTORS = [
  'meta[property="product:price:amount"]',
  'meta[property="og:price:amount"]',
  'meta[itemprop="price"]',
  '[itemprop="price"]',
];

/**
 * Converte textos como "R$ 1.299,90", "1,299.90", "1299.9" ou 1299.9 em número.
 * Retorna null se não houver um preço válido.
 */
export function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? round2(value) : null;

  const text = String(value).replace(/[\s ]+/g, ' ');
  const match = text.match(/R\$\s*(\d[\d.,]*)/) || text.match(/\d[\d.,]*/);
  if (!match) return null;
  const raw = (match[1] ?? match[0]).replace(/[.,]+$/, '');

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let decimalIdx = -1;
  if (lastComma !== -1 && lastDot !== -1) {
    decimalIdx = Math.max(lastComma, lastDot);
  } else if (lastComma !== -1 || lastDot !== -1) {
    const idx = Math.max(lastComma, lastDot);
    const sep = raw[idx];
    const digitsAfter = raw.length - idx - 1;
    const sepCount = raw.split(sep).length - 1;
    // "1.299" e "12.999.999" são milhar no Brasil; "1299,9", "1299.90" e "0.999" são decimais.
    const isThousands = digitsAfter === 3 && (sepCount > 1 || !raw.startsWith('0'));
    decimalIdx = isThousands ? -1 : idx;
  }

  let normalized = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c >= '0' && c <= '9') normalized += c;
    else if (i === decimalIdx) normalized += '.';
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function* walkJson(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkJson(item);
  } else if (node && typeof node === 'object') {
    yield node;
    for (const key of ['@graph', 'mainEntity', 'hasVariant', 'itemListElement']) {
      if (node[key]) yield* walkJson(node[key]);
    }
  }
}

function isType(node, type) {
  const t = node['@type'];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

function priceFromOffers(offers) {
  for (const offer of [offers].flat()) {
    if (!offer || typeof offer !== 'object') continue;
    const spec = [offer.priceSpecification].flat()[0];
    const price = parsePrice(offer.price ?? offer.lowPrice ?? spec?.price);
    if (price) return price;
    if (offer.offers) {
      const nested = priceFromOffers(offer.offers);
      if (nested) return nested;
    }
  }
  return null;
}

function fromJsonLd($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    try {
      data = JSON.parse($(el).text().replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      continue;
    }
    for (const node of walkJson(data)) {
      if (!isType(node, 'Product') && !isType(node, 'ProductGroup')) continue;
      const price = priceFromOffers(node.offers);
      if (price) return { price, title: node.name, source: 'json-ld' };
    }
  }
  return null;
}

function priceFromElement($el) {
  // Mercado Livre divide o preço em pedaços: <span class="andes-money-amount__fraction">3.514</span><span class="...__cents">05</span>
  const money = $el.is('.andes-money-amount') ? $el : $el.find('.andes-money-amount').first();
  const fraction = money.find('.andes-money-amount__fraction').first().text().trim();
  if (fraction) {
    const cents = money.find('.andes-money-amount__cents').first().text().trim();
    return parsePrice(`R$ ${fraction},${cents || '00'}`);
  }
  return parsePrice($el.attr('content') ?? $el.attr('value') ?? $el.text());
}

/** Link de afiliado do Mercado Livre (/social/...): o produto indicado aparece no card em destaque. */
function fromMercadoLivreSocial($) {
  const cards = $('.poly-card').toArray().map((c) => $(c));
  if (!cards.length) return null;
  const titleOf = (card) => card.find('.poly-component__title').first().text().replace(/\s+/g, ' ').trim();
  const ogTitle = ($('meta[property="og:title"]').attr('content') || '').replace(/\s*-\s*R\$.*$/, '').trim();
  // Só aceita o card do produto do link (título igual ao da página), para não ler outro produto por engano.
  const card = ogTitle ? cards.find((c) => titleOf(c) === ogTitle) : cards[0];
  if (!card) return null;
  const price = priceFromElement(card.find('.poly-price__current .andes-money-amount').first());
  return price ? { price, title: titleOf(card) || ogTitle, source: 'mercado livre: card em destaque' } : null;
}

function firstMatch($, selectors, source) {
  for (const sel of selectors) {
    for (const el of $(sel).toArray()) {
      const price = priceFromElement($(el));
      if (price) return { price, source: `${source}: ${sel}` };
    }
  }
  return null;
}

function pageTitle($) {
  const t =
    $('meta[property="og:title"]').attr('content') ||
    $('#productTitle').text() ||
    $('h1').first().text() ||
    $('title').text();
  return t ? t.replace(/\s+/g, ' ').trim().slice(0, 150) : '';
}

/** Extrai { price, title, source } de um HTML. Lança erro se não achar o preço. */
export function extractFromHtml(html, url, selector) {
  const $ = cheerio.load(html);
  const host = new URL(url).hostname;
  let found = null;

  if (selector) {
    let matched;
    try {
      matched = $(selector);
    } catch {
      throw new Error(`Seletor CSS inválido: ${selector}`);
    }
    if (!matched.length) throw new Error(`O seletor "${selector}" não encontrou nada na página`);
    found = firstMatch($, [selector], 'seletor');
    if (!found) throw new Error(`O seletor "${selector}" achou elementos, mas nenhum com preço`);
  }

  if (/(^|\.)mercadoli(vre|bre)\./.test(host) && new URL(url).pathname.startsWith('/social/')) {
    found ||= fromMercadoLivreSocial($);
  }

  const site = SITE_SELECTORS.find((s) => s.host.test(host));
  found ||= site ? firstMatch($, site.selectors, 'loja') : null;

  const ld = fromJsonLd($);
  found ||= ld;
  found ||= firstMatch($, META_SELECTORS, 'meta');

  if (!found) {
    const blocked = /captcha|are you a human|robot check|access denied|perimeterx|cf-chl|challenge-platform|negative_traffic/i.test(html);
    throw new Error(
      blocked
        ? 'A loja bloqueou o acesso automático (captcha/anti-bot). Tente de novo mais tarde.'
        : 'Preço não encontrado. Informe um seletor CSS para este produto.',
    );
  }
  const title = (found.title || ld?.title || pageTitle($) || host).toString().trim().slice(0, 150);
  return { price: found.price, title, source: found.source };
}

export async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.7,en;q=0.6',
      'Cache-Control': 'no-cache',
    },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error(`A loja bloqueou o acesso automático (HTTP ${res.status}). Essa loja não funciona com o monitor.`);
  }
  if (!res.ok) throw new Error(`A loja respondeu HTTP ${res.status}`);
  return res.text();
}

export async function checkPrice(url, selector) {
  const html = await fetchPage(url);
  return extractFromHtml(html, url, selector);
}
