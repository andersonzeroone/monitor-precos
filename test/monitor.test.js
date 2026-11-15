import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrice, buildMessages, alertBlock, formatBRL } from '../src/monitor.js';
import { normalizePhone } from '../src/whatsapp.js';

test('alerta de preço alvo: avisa uma vez e de novo só se cair mais', () => {
  let p = { target_price: 1000, last_price: 1200, last_alert_price: null };
  let r = evaluatePrice(p, 999, 0);
  assert.deepEqual(r.reasons, ['target']);

  p = { ...p, last_price: 999, last_alert_price: r.lastAlertPrice };
  assert.deepEqual(evaluatePrice(p, 999, 0).reasons, []); // mesmo preço: não repete
  assert.deepEqual(evaluatePrice(p, 950, 0).reasons, ['target']); // caiu mais: avisa

  r = evaluatePrice(p, 1100, 0); // voltou acima do alvo: rearma
  assert.equal(r.lastAlertPrice, null);
});

test('faixa: avisa ao entrar, a cada nova queda e destaca o preço ideal', () => {
  let p = { alert_from_price: 2800, target_price: 2500, last_price: null, last_alert_price: null };
  const step = (price) => {
    const r = evaluatePrice(p, price, 0);
    p = { ...p, last_price: price, last_alert_price: r.lastAlertPrice };
    return r.reasons;
  };
  assert.deepEqual(step(2950), []); // acima da faixa
  assert.deepEqual(step(2790), ['range']); // entrou na faixa
  assert.deepEqual(step(2790), []); // mesmo preço: não repete
  assert.deepEqual(step(2650), ['range']); // caiu mais
  assert.deepEqual(step(2480), ['target']); // chegou no ideal
  assert.deepEqual(step(2300), ['target']); // caiu mais ainda
  assert.deepEqual(step(2900), []); // saiu da faixa: rearma
  assert.deepEqual(step(2790), ['range']); // voltou: avisa de novo
});

test('faixa só com "avisar a partir de" (sem preço ideal)', () => {
  const p = { alert_from_price: 1000, target_price: null, last_price: 1100, last_alert_price: null };
  assert.deepEqual(evaluatePrice(p, 999, 0).reasons, ['range']);
});

test('alerta de queda percentual', () => {
  const p = { target_price: null, last_price: 1000, last_alert_price: null };
  assert.deepEqual(evaluatePrice(p, 960, 5).reasons, []);
  assert.deepEqual(evaluatePrice(p, 950, 5).reasons, ['drop']);
  assert.deepEqual(evaluatePrice(p, 500, 0).reasons, []); // 0 = desligado
  assert.deepEqual(evaluatePrice({ ...p, last_price: null }, 500, 5).reasons, []); // primeira leitura
});

test('mensagem formatada e quebrada em partes', () => {
  const block = alertBlock({ name: 'TV 55"', url: 'https://x.com/tv', price: 2199, prev: 2599, target: 2200, lowest: 2399, reasons: ['target'] });
  assert.match(block, /R\$ 2\.199,00 \(antes R\$ 2\.599,00, -15%\)/);
  assert.match(block, /preço ideal \(R\$ 2\.200,00\)/);
  assert.match(block, /Menor preço/);

  const inRange = alertBlock({ name: 'TV', url: 'u', price: 2790, prev: 2950, target: 2500, alertFrom: 2800, lowest: 2790, reasons: ['range'] });
  assert.match(inRange, /Entrou na sua faixa: avisar a partir de R\$ 2\.800,00 · ideal R\$ 2\.500,00/);
  assert.doesNotMatch(inRange, /Menor preço/); // igual ao menor, não é novo recorde

  const msgs = buildMessages(Array.from({ length: 40 }, () => block));
  assert.ok(msgs.length > 1);
  assert.ok(msgs.every((m) => m.length <= 3000));
  assert.deepEqual(buildMessages([]), []);
  assert.equal(formatBRL(1234.5), 'R$ 1.234,50');
});

test('normaliza telefones brasileiros', () => {
  assert.equal(normalizePhone('(11) 98888-7777'), '5511988887777');
  assert.equal(normalizePhone('+55 21 3333-4444'), '552133334444');
  assert.throws(() => normalizePhone('123'));
});
