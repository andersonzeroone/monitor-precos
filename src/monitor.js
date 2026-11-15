import { checkPrice } from './scraper.js';
import { getSettings } from './db.js';
import { sendWhatsApp } from './whatsapp.js';

const MAX_MESSAGE = 3000; // WhatsApp aceita ~4096; deixamos folga.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatBRL(n) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
}

/**
 * Decide se um novo preço merece alerta.
 * - Faixa: avisa quando o preço fica <= "avisar a partir de" (alert_from_price) e de novo a cada nova queda.
 *   Se chegar no "preço ideal" (target_price) ou abaixo, o aviso vem destacado ('target').
 *   Se voltar acima do início da faixa, rearma. Sem "a partir de", a faixa começa no preço ideal.
 * - Queda: avisa quando cai pelo menos dropPct% em relação à leitura anterior.
 */
export function evaluatePrice(product, price, dropPct) {
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

  const prev = product.last_price;
  if (dropPct > 0 && prev != null && price <= prev * (1 - dropPct / 100)) reasons.push('drop');

  return { reasons, lastAlertPrice };
}

export function alertBlock({ name, url, price, prev, target, alertFrom, lowest, reasons }) {
  const lines = [`*${name}*`];
  let priceLine = `💰 ${formatBRL(price)}`;
  if (prev != null && prev !== price) {
    const pct = Math.round(((prev - price) / prev) * 100);
    priceLine += ` (antes ${formatBRL(prev)}${pct > 0 ? `, -${pct}%` : ''})`;
  }
  lines.push(priceLine);
  if (reasons.includes('target')) lines.push(`🎯 Chegou no seu preço ideal (${formatBRL(target)})`);
  if (reasons.includes('range')) {
    lines.push(
      target != null
        ? `📉 Entrou na sua faixa: avisar a partir de ${formatBRL(alertFrom)} · ideal ${formatBRL(target)}`
        : `📉 Abaixo de ${formatBRL(alertFrom)}, seu limite para avisar`,
    );
  }
  if (lowest == null || price < lowest) lines.push('⭐ Menor preço já registrado');
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

  const blocks = [];
  let failed = 0;

  for (const [i, p] of products.entries()) {
    if (i > 0) await sleep(delayMs + Math.random() * delayMs); // não martelar as lojas
    const checkedAt = new Date().toISOString();
    try {
      const { price, title } = await checkPrice(p.url, p.selector);
      const name = p.name || title;
      const { reasons, lastAlertPrice } = evaluatePrice(p, price, dropPct);
      const lowest = p.lowest_price == null ? price : Math.min(p.lowest_price, price);

      insertPrice.run(p.id, price, checkedAt);
      updateOk.run(name, price, lowest, checkedAt, lastAlertPrice, p.id);

      if (reasons.length) {
        blocks.push(
          alertBlock({ name, url: p.url, price, prev: p.last_price, target: p.target_price, alertFrom: p.alert_from_price, lowest: p.lowest_price, reasons }),
        );
      }
    } catch (err) {
      failed++;
      const msg = err.name === 'TimeoutError' ? 'A loja demorou demais para responder' : err.message;
      updateErr.run(checkedAt, msg, p.id);
      console.error(`[monitor] ${p.name || p.url}: ${msg}`);
    }
  }

  for (const text of buildMessages(blocks)) await notifyAll(db, text);

  return { startedAt, finishedAt: new Date().toISOString(), checked: products.length, failed, alerts: blocks.length };
}
