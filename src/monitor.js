import { checkPrice } from './scraper.js';
import { searchProduct } from './search.js';
import { getSettings } from './db.js';
import { sendWhatsApp } from './whatsapp.js';

const MAX_MESSAGE = 3000; // WhatsApp aceita ~4096; deixamos folga.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatBRL(n) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
}

/**
 * Decide se um novo preço merece alerta.
 * - Faixa: avisa quando o preço fica <= "avisar quando custar até" (alert_from_price) e de novo a cada nova queda.
 *   Se chegar no "preço ideal" (target_price) ou abaixo, o aviso vem destacado ('target').
 *   Se voltar acima do limite, rearma. Sem limite, a faixa começa no preço ideal.
 * - Queda: avisa quando cai pelo menos dropPct% em relação a prev (a leitura anterior; veja dropBaseline).
 */
export function evaluatePrice(product, price, dropPct, prev = product.last_price) {
  const reasons = [];
  let lastAlertPrice = product.last_alert_price ?? null;
  const ideal = product.target_price ?? null;
  const from = product.alert_from_price ?? ideal;

  if (from != null) {
    if (price <= from) {
      if (lastAlertPrice == null || price < lastAlertPrice) {
        reasons.push(ideal != null && price <= ideal ? 'target' : 'range');
        lastAlertPrice = price;
      }
    } else {
      lastAlertPrice = null;
    }
  }

  if (dropPct > 0 && prev != null && price <= prev * (1 - dropPct / 100)) reasons.push('drop');

  return { reasons, lastAlertPrice };
}

/**
 * Base do aviso de queda. Link: a leitura anterior (last_price). Busca: o preço anterior da mesma
 * oferta (mesma URL) no offers_json da rodada passada; oferta nova não tem base, e quem decide é só a
 * faixa. Assim, a melhor oferta mudar de loja (uma fonte que falhou e voltou) não vira queda falsa.
 * Sem last_price (primeira leitura, ou a busca/forma de pagamento mudou) não há base.
 */
export function dropBaseline(product, result) {
  if (product.kind !== 'search' || product.last_price == null) return product.last_price ?? null;
  let previous;
  try {
    previous = JSON.parse(product.offers_json || '{}').offers;
  } catch {
    return null;
  }
  return (Array.isArray(previous) && previous.find((o) => o.url === result.url)?.price) || null;
}

export function alertBlock({ name, url, price, prev, target, alertFrom, lowest, reasons, store, offers, installments }) {
  const lines = [`*${name}*`];
  let priceLine = `💰 ${formatBRL(price)}${installments ? ' no total parcelado' : ''}${store ? ` na ${store}` : ''}`;
  const pct = prev ? Math.round(((prev - price) / prev) * 100) : null;
  if (prev != null && prev !== price) priceLine += ` (antes ${formatBRL(prev)}${pct > 0 ? `, -${pct}%` : ''})`;
  lines.push(priceLine);
  if (installments) lines.push(`💳 ${installments.count}x de ${formatBRL(installments.value)} sem juros`);
  if (reasons.includes('target')) lines.push(`🎯 Chegou no seu preço ideal (${formatBRL(target)})`);
  if (reasons.includes('range')) {
    lines.push(
      target != null
        ? `📉 Dentro do seu limite de ${formatBRL(alertFrom)} (preço ideal: ${formatBRL(target)})`
        : `📉 Dentro do seu limite de ${formatBRL(alertFrom)}`,
    );
  }
  // Só queda (fora da faixa ou já avisado nesse preço): diz por que avisou, para não parecer engano.
  if (reasons.includes('drop') && !reasons.includes('target') && !reasons.includes('range')) {
    const limit = alertFrom ?? target;
    const above = limit != null && price > limit;
    lines.push(
      `📊 Aviso de queda: −${pct}% desde a última verificação` +
        (above ? `. Ainda acima do seu ${alertFrom != null ? 'limite' : 'preço ideal'} de ${formatBRL(limit)}` : ''),
    );
  }
  if (lowest == null || price < lowest) lines.push('⭐ Menor preço já registrado');
  const others = (offers ?? []).filter((o) => o.url !== url).slice(0, 2);
  if (others.length) lines.push(`Outras ofertas: ${others.map((o) => `${o.store} ${formatBRL(o.price)}`).join(' · ')}`);
  lines.push(url);
  return lines.join('\n');
}

/** Junta os blocos em uma ou mais mensagens que caibam no limite do WhatsApp. */
export function buildMessages(blocks, header = '🔥 *Alerta de preço*') {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > MAX_MESSAGE && current !== header) {
      messages.push(current);
      current = header;
    }
    current += `\n\n${block}`;
  }
  if (current !== header) messages.push(current);
  return messages;
}

/** Envia o texto a todos os contatos ativos e registra no histórico de alertas. */
export async function notifyAll(db, text) {
  const { whatsapp_provider: provider } = getSettings(db);
  const contacts = db.prepare('SELECT * FROM contacts WHERE active = 1').all();
  const results = [];
  for (const c of contacts) {
    try {
      results.push({ contact: c.name, ok: true, info: await sendWhatsApp(provider, c, text) });
    } catch (err) {
      results.push({ contact: c.name, ok: false, info: err.message });
      console.error(`[whatsapp] falha para ${c.name}: ${err.message}`);
    }
    await sleep(1000);
  }
  const summary = contacts.length
    ? results.map((r) => `${r.contact}: ${r.ok ? r.info : `ERRO ${r.info}`}`).join(' | ')
    : 'nenhum contato ativo';
  db.prepare('INSERT INTO alerts (message, sent_at, result) VALUES (?, ?, ?)').run(text, new Date().toISOString(), summary);
  return results;
}

/** Conta como entregue se pelo menos um contato recebeu, ou se não há contato ativo (não adianta repetir). */
export function delivered(results) {
  return results.length === 0 || results.some((r) => r.ok);
}

/** Verifica os preços (todos os ativos ou só os ids informados) e dispara os alertas. */
export async function runCheck(db, { productIds, delayMs = 1500 } = {}) {
  const startedAt = new Date().toISOString();
  const dropPct = Number(getSettings(db).drop_alert_pct) || 0;
  const products = productIds
    ? db.prepare(`SELECT * FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`).all(...productIds)
    : db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all();

  const insertPrice = db.prepare('INSERT INTO prices (product_id, price, checked_at) VALUES (?, ?, ?)');
  const updateOk = db.prepare(`
    UPDATE products SET name = ?, last_price = ?, lowest_price = ?, last_checked_at = ?, last_error = NULL, last_alert_price = ?
    WHERE id = ?`);
  const updateErr = db.prepare('UPDATE products SET last_checked_at = ?, last_error = ? WHERE id = ?');
  const updateBest = db.prepare('UPDATE products SET best_store = ?, best_url = ?, offers_json = ? WHERE id = ?');

  const blocks = [];
  const pending = []; // avisos de faixa: o last_alert_price novo só é gravado depois que o WhatsApp entregar
  let failed = 0;

  for (const [i, p] of products.entries()) {
    if (i > 0) await sleep(delayMs + Math.random() * delayMs); // não martelar as lojas
    const checkedAt = new Date().toISOString();
    try {
      // Produto por busca: o "preço" é o da oferta mais barata que bate com as palavras, em qualquer fonte.
      const search = p.kind === 'search';
      const parcelado = p.payment === 'parcelado';
      let result = search ? await searchProduct(p) : await checkPrice(p.url, p.selector);
      // Link no modo parcelado: vale o total das parcelas sem juros (a busca já faz isso sozinha).
      if (!search && parcelado) {
        if (!result.installments) throw new Error('Esta página não mostra parcelamento sem juros. Mude a forma de pagamento para à vista.');
        result = { ...result, price: result.installments.total };
      }
      const { price, title } = result;
      const name = p.name || title;
      const prev = dropBaseline(p, result); // busca: preço anterior da mesma oferta, não da melhor
      const { reasons, lastAlertPrice } = evaluatePrice(p, price, dropPct, prev);
      const lowest = p.lowest_price == null ? price : Math.min(p.lowest_price, price);
      // Aviso de faixa: mantém o last_alert_price antigo até a entrega; se o envio falhar, a próxima rodada avisa de novo.
      const rangeAlert = reasons.includes('target') || reasons.includes('range');
      if (rangeAlert) pending.push({ id: p.id, lastAlertPrice });

      insertPrice.run(p.id, price, checkedAt);
      updateOk.run(name, price, lowest, checkedAt, rangeAlert ? (p.last_alert_price ?? null) : lastAlertPrice, p.id);
      if (search) {
        updateBest.run(result.store, result.url, JSON.stringify({ offers: result.offers, failures: result.failures }), p.id);
      } else {
        updateBest.run(null, null, JSON.stringify({ installments: result.installments ?? null }), p.id);
      }

      if (reasons.length) {
        blocks.push(
          alertBlock({
            name,
            url: search ? result.url : p.url,
            price,
            prev: prev ?? p.last_price, // com aviso de queda, é a mesma base que decidiu a queda
            target: p.target_price,
            alertFrom: p.alert_from_price,
            lowest: p.lowest_price,
            reasons,
            store: search ? result.store : null,
            offers: search ? result.offers : null,
            installments: parcelado ? result.installments : null,
          }),
        );
      }
    } catch (err) {
      failed++;
      const msg = err.name === 'TimeoutError' ? 'A loja demorou demais para responder' : err.message;
      updateErr.run(checkedAt, msg, p.id);
      console.error(`[monitor] ${p.name || p.url}: ${msg}`);
    }
  }

  let ok = true;
  for (const text of buildMessages(blocks)) ok = delivered(await notifyAll(db, text)) && ok;
  if (ok) {
    const markAlerted = db.prepare('UPDATE products SET last_alert_price = ? WHERE id = ?');
    for (const a of pending) markAlerted.run(a.lastAlertPrice, a.id);
  } else if (pending.length) {
    console.error('[monitor] o WhatsApp não entregou o alerta; ele vai de novo na próxima verificação');
  }

  return { startedAt, finishedAt: new Date().toISOString(), checked: products.length, failed, alerts: blocks.length, delivered: ok };
}
