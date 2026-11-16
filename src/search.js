// Busca por nome em várias fontes. Em vez de vigiar um link, vigia o produto: a cada rodada procura
// o termo em cada fonte e fica com a oferta mais barata cujo título bate com as palavras escolhidas.
import * as cheerio from 'cheerio';
import { fetchPage, parsePrice, looksBlocked, parseInstallments } from './scraper.js';

const MIN = 60_000;

export const DEFAULT_SOURCES = 'buscape,amazon,kabum';
export const DEFAULT_EXCLUDED = 'suporte, controle, capa, cabo, película, combo, usado, recondicionado';

function nextData(html) {
  const text = cheerio.load(html)('#__NEXT_DATA__').text();
  if (!text) throw new Error('formato da página mudou');
  return JSON.parse(text);
}

// Buscapé e Zoom são do mesmo grupo e usam o mesmo formato. Cada resultado é um produto do catálogo
// (type "product", com o menor preço entre as lojas em bestOffer) ou uma oferta avulsa de uma loja
// (type "offer", com merchantName).
function comparator(id, label, origin) {
  return {
    id,
    label,
    structured: true, // página veio com os dados: lista vazia é "sem resultado", não bloqueio
    minIntervalMin: 10, // comparadores: no máximo uma consulta a cada 10 min por busca
    url: (q) => `${origin}/search?q=${encodeURIComponent(q)}`,
    parse(html) {
      const hits = nextData(html).props?.initialReduxState?.hits?.hits;
      if (!Array.isArray(hits)) throw new Error('formato da página mudou');
      return hits
        .filter((h) => !h.type || h.type === 'product' || h.type === 'offer')
        .map((h) => {
          const merchant = h.bestOffer?.merchantName ?? h.merchantName;
          const price = parsePrice(h.price);
          // O comparador só escreve "sem juros" quando o total parcelado é igual ao preço à vista.
          const inst = h.installments;
          const installments =
            price && inst?.amount_months > 1 && inst.total_value <= price * 1.005
              ? { count: inst.amount_months, value: inst.price, total: inst.total_value }
              : null;
          return {
            title: h.name,
            price,
            store: merchant ? `${merchant} (via ${label})` : label,
            url: h.url ? new URL(h.url, origin).toString() : null,
            installments,
          };
        });
    },
  };
}

export const SOURCES = {
  buscape: comparator('buscape', 'Buscapé', 'https://www.buscape.com.br'),
  zoom: comparator('zoom', 'Zoom', 'https://www.zoom.com.br'),
  amazon: {
    id: 'amazon',
    label: 'Amazon',
    minIntervalMin: 10,
    url: (q) => `https://www.amazon.com.br/s?k=${encodeURIComponent(q)}`,
    parse(html) {
      const $ = cheerio.load(html);
      return $('[data-component-type="s-search-result"]')
        .toArray()
        .map((el) => {
          const card = $(el);
          const asin = card.attr('data-asin');
          const offscreen = parsePrice(card.find('.a-price .a-offscreen').first().text());
          const whole = card.find('.a-price .a-price-whole').first().text().replace(/[^\d.]/g, '');
          const fraction = card.find('.a-price .a-price-fraction').first().text().replace(/\D/g, '');
          return {
            title: card.find('h2').text().replace(/\s+/g, ' ').trim(),
            price: offscreen ?? (whole ? parsePrice(`R$ ${whole},${fraction || '00'}`) : null),
            store: 'Amazon',
            url: asin ? `https://www.amazon.com.br/dp/${asin}` : null,
            installments: parseInstallments(card.text()),
          };
        });
    },
  },
  kabum: {
    id: 'kabum',
    label: 'Kabum',
    structured: true,
    minIntervalMin: 0,
    url: (q) => `https://www.kabum.com.br/busca/${encodeURIComponent(q.trim().replace(/\s+/g, '-'))}`,
    parse(html) {
      const items = nextData(html).props?.pageProps?.data?.catalogServer?.data;
      if (!Array.isArray(items)) throw new Error('formato da página mudou');
      return items
        .filter((i) => i.available !== false)
        .map((i) => {
          const prices = [i.priceWithDiscount, i.price].map(parsePrice).filter(Boolean); // menor = à vista/Pix
          const seller = i.sellerName && !/kabum/i.test(i.sellerName) ? ` (vendido por ${i.sellerName})` : '';
          // "10x de R$ 389,41": sem juros quando as parcelas somam o preço no cartão (price).
          const m = String(i.maxInstallment ?? '').match(/(\d{1,2})\s*x\s*de\s*R\$\s*([\d.]+,\d{2})/i);
          const card = parsePrice(i.price);
          const count = m ? Number(m[1]) : 0;
          const value = m ? parsePrice(m[2]) : null;
          const installments =
            count >= 2 && value && card && Math.abs(count * value - card) <= Math.max(1, card * 0.005)
              ? { count, value, total: card }
              : null;
          return {
            title: i.name,
            price: prices.length ? Math.min(...prices) : null,
            store: `Kabum${seller}`,
            url: i.code ? `https://www.kabum.com.br/produto/${i.code}/${i.friendlyName ?? ''}` : null,
            installments,
          };
        });
    },
  },
};

export function parseSources(str) {
  const ids = String(str || DEFAULT_SOURCES)
    .split(/[,\s]+/)
    .filter((id) => SOURCES[id]);
  return [...new Set(ids)];
}

const normalize = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Palavras obrigatórias: separadas por vírgula ou espaço. Sem nenhuma, valem as palavras da busca. */
export function requiredWords(required, query) {
  const words = normalize(required).split(/[,;\s]+/).filter(Boolean);
  return words.length ? words : normalize(query).split(/\s+/).filter(Boolean);
}

/** Palavras excluídas: separadas por vírgula (aceita expressões, como "open box"). */
export function excludedWords(excluded) {
  return normalize(excluded)
    .split(/[,;]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

// Números precisam estar "soltos" ("55" casa com 55", 55C6K e 55 polegadas, mas não com 550 ou 1550).
function hasWord(text, word) {
  return /^\d+$/.test(word) ? new RegExp(`(?<!\\d)${word}(?!\\d)`).test(text) : text.includes(word);
}

/** Ofertas que batem com as palavras e o preço mínimo, da mais barata para a mais cara. */
export function matchOffers(offers, { query, required, excluded, minPrice }) {
  const req = requiredWords(required, query);
  const exc = excludedWords(excluded);
  const seen = new Set();
  return offers
    .filter((o) => o.price && o.url && o.title)
    .filter((o) => {
      const text = normalize(o.title);
      return req.every((w) => hasWord(text, w)) && !exc.some((w) => text.includes(w));
    })
    .filter((o) => minPrice == null || o.price >= minPrice)
    .filter((o) => {
      // Mesma oferta vinda do Buscapé e do Zoom (mesmo catálogo) conta uma vez.
      const key = `${o.price}|${normalize(o.store).replace(/ \(via [^)]*\)$/, '')}|${normalize(o.title)}`;
      if (seen.has(o.url) || seen.has(key)) return false;
      seen.add(o.url).add(key);
      return true;
    })
    .sort((a, b) => a.price - b.price);
}

const cache = new Map(); // "fonte|busca" -> { at, offers }

/** Busca numa fonte, respeitando o intervalo mínimo entre consultas iguais. */
export async function searchSource(id, query, now = Date.now()) {
  const source = SOURCES[id];
  const key = `${id}|${normalize(query).trim()}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < source.minIntervalMin * MIN) return cached.offers;

  const html = await fetchPage(source.url(query));
  let offers;
  try {
    offers = source.parse(html);
  } catch (err) {
    throw new Error(looksBlocked(html) ? 'bloqueou o acesso automático' : err.message);
  }
  // Páginas normais às vezes citam "captcha" nos scripts; só desconfia de bloqueio se a página não
  // trouxe os dados estruturados (Amazon, que é HTML puro, sem nenhum card).
  if (!offers.length && !source.structured && looksBlocked(html)) throw new Error('bloqueou o acesso automático');
  cache.set(key, { at: now, offers });
  return offers;
}

/**
 * Forma de pagamento: 'avista' usa o menor preço (Pix/à vista); 'parcelado' só aceita ofertas com
 * parcelamento sem juros e usa o total parcelado como preço.
 */
export function applyPayment(offers, payment) {
  if (payment !== 'parcelado') return offers;
  return offers.filter((o) => o.installments).map((o) => ({ ...o, price: o.installments.total }));
}

/** Busca em todas as fontes do produto. Uma fonte com falha não impede as outras. */
export async function findOffers(p) {
  const ids = parseSources(p.sources);
  const all = [];
  const failures = [];
  for (const id of ids) {
    try {
      all.push(...(await searchSource(id, p.query)));
    } catch (err) {
      failures.push(`${SOURCES[id].label}: ${err.name === 'TimeoutError' ? 'não respondeu' : err.message}`);
    }
  }
  const offers = matchOffers(applyPayment(all, p.payment), {
    query: p.query,
    required: p.required_words,
    excluded: p.excluded_words,
    minPrice: p.min_price,
  });
  return { ids, all, offers, failures };
}

/** Melhor oferta do produto (e as 5 mais baratas). Lança erro se nenhuma oferta bater. */
export async function searchProduct(p) {
  const { ids, all, offers, failures } = await findOffers(p);
  if (!offers.length) {
    const why =
      p.payment === 'parcelado'
        ? `Nenhuma oferta com parcelamento sem juros e essas palavras entre ${all.length} resultado(s).`
        : `Nenhuma oferta com essas palavras entre ${all.length} resultado(s). Revise as palavras obrigatórias.`;
    throw new Error(
      failures.length === ids.length
        ? `Nenhuma fonte respondeu (${failures.join('; ')})`
        : why + (failures.length ? ` Falhas: ${failures.join('; ')}` : ''),
    );
  }
  const best = offers[0];
  return {
    price: best.price,
    title: best.title,
    store: best.store,
    url: best.url,
    installments: best.installments ?? null,
    offers: offers.slice(0, 5),
    failures,
    total: all.length,
  };
}
