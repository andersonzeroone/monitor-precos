import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrice, buildMessages, alertBlock, formatBRL, delivered, dropBaseline } from '../src/monitor.js';
import { normalizePhone, samePhone } from '../src/whatsapp.js';

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

test('faixa só com "avisar quando custar até" (sem preço ideal)', () => {
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

test('busca: a queda compara com o preço anterior da mesma oferta, não com a melhor anterior', () => {
  const kabum = 'https://www.kabum.com.br/produto/938048/tv';
  const amazon = 'https://www.amazon.com.br/dp/B0F7JZMVKF';
  // Rodada anterior: a Amazon falhou e a melhor oferta virou a da Kabum (R$ 3.399).
  const p = {
    kind: 'search',
    alert_from_price: 3400,
    target_price: null,
    last_price: 3399,
    last_alert_price: 3099, // já avisou a R$ 3.099 (Amazon)
    offers_json: JSON.stringify({ offers: [{ url: kabum, price: 3399 }, { url: 'x', price: 4954 }], failures: ['Amazon: A loja respondeu HTTP 503'] }),
  };

  // A Amazon voltou a R$ 3.099: oferta nova para a rodada, sem base de queda; e 3.099 não é < 3.099.
  assert.equal(dropBaseline(p, { url: amazon, price: 3099 }), null);
  assert.deepEqual(evaluatePrice(p, 3099, 5, dropBaseline(p, { url: amazon })).reasons, []);
  assert.deepEqual(evaluatePrice(p, 3099, 5).reasons, ['drop']); // comparando com o last_price daria a queda falsa

  // A mesma oferta da Kabum caindo de verdade: base é o preço dela na rodada anterior.
  assert.equal(dropBaseline(p, { url: kabum }), 3399);
  assert.deepEqual(evaluatePrice(p, 3199, 5, dropBaseline(p, { url: kabum })).reasons, ['drop']);
  assert.equal(dropBaseline({ ...p, offers_json: JSON.stringify({ offers: [{ url: 'x', price: 4954 }] }) }, { url: 'x' }), 4954);

  // Sem leitura anterior (primeira, ou a busca/forma de pagamento mudou), offers_json vazio ou inválido: sem base.
  assert.equal(dropBaseline({ ...p, last_price: null }, { url: kabum }), null);
  assert.equal(dropBaseline({ ...p, offers_json: null }, { url: kabum }), null);
  assert.equal(dropBaseline({ ...p, offers_json: '{' }, { url: kabum }), null);

  // Link continua comparando com a leitura anterior.
  assert.equal(dropBaseline({ kind: 'link', last_price: 4249, offers_json: '{"installments":null}' }, { url: 'u' }), 4249);
});

test('aviso só de queda explica o motivo e diz se ainda está acima da faixa', () => {
  // Caso real: TV com preço ideal R$ 3.200 e sem limite, avisada a R$ 3.766,90 só pela queda.
  const tv = { name: 'TV C6K', url: 'u', price: 3766.9, prev: 4249, target: 3200, alertFrom: null, lowest: 3099, reasons: ['drop'] };
  const block = alertBlock(tv);
  assert.match(block, /\(antes R\$ 4\.249,00, -11%\)/);
  assert.match(block, /📊 Aviso de queda: −11% desde a última verificação\. Ainda acima do seu preço ideal de R\$ 3\.200,00/);

  const withLimit = alertBlock({ ...tv, alertFrom: 3400 });
  assert.match(withLimit, /−11% desde a última verificação\. Ainda acima do seu limite de R\$ 3\.400,00/);

  // Sem faixa nenhuma: só o motivo.
  const noRange = alertBlock({ ...tv, target: null });
  assert.match(noRange, /📊 Aviso de queda: −11% desde a última verificação$/m);
  assert.doesNotMatch(noRange, /Ainda acima/);

  // Dentro da faixa, mas já avisado nesse preço: não diz "acima".
  assert.doesNotMatch(alertBlock({ ...tv, alertFrom: 4000 }), /Ainda acima/);

  // Com aviso de faixa junto, a linha de faixa já explica.
  assert.doesNotMatch(alertBlock({ ...tv, price: 3100, reasons: ['target', 'drop'] }), /📊/);
  assert.doesNotMatch(alertBlock({ ...tv, alertFrom: 3800, reasons: ['range', 'drop'] }), /📊/);
});

test('alerta só conta como entregue se algum contato recebeu', () => {
  assert.equal(delivered([{ ok: false }, { ok: true }]), true);
  assert.equal(delivered([{ ok: false }, { ok: false }]), false); // WhatsApp fora: avisa de novo na próxima rodada
  assert.equal(delivered([]), true); // sem contato ativo: não adianta repetir
});

test('mensagem formatada e quebrada em partes', () => {
  const block = alertBlock({ name: 'TV 55"', url: 'https://x.com/tv', price: 2199, prev: 2599, target: 2200, lowest: 2399, reasons: ['target'] });
  assert.match(block, /R\$ 2\.199,00 \(antes R\$ 2\.599,00, -15%\)/);
  assert.match(block, /preço ideal \(R\$ 2\.200,00\)/);
  assert.match(block, /Menor preço/);

  const inRange = alertBlock({ name: 'TV', url: 'u', price: 2790, prev: 2950, target: 2500, alertFrom: 2800, lowest: 2790, reasons: ['range'] });
  assert.match(inRange, /Dentro do seu limite de R\$ 2\.800,00 \(preço ideal: R\$ 2\.500,00\)/);
  assert.doesNotMatch(inRange, /Menor preço/); // igual ao menor, não é novo recorde

  const parcelado = alertBlock({ name: 'TV', url: 'u', price: 3699, prev: null, target: null, alertFrom: 3800, lowest: null, reasons: ['range'], store: 'Kabum', installments: { count: 10, value: 369.9, total: 3699 } });
  assert.match(parcelado, /R\$ 3\.699,00 no total parcelado na Kabum/);
  assert.match(parcelado, /💳 10x de R\$ 369,90 sem juros/);

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

test('reconhece o mesmo número com e sem o 9 extra', () => {
  assert.equal(samePhone('5511988887777', '551188887777'), true); // o WhatsApp às vezes guarda sem o 9
  assert.equal(samePhone('5511988887777', '5511988887777'), true);
  assert.equal(samePhone('5511988887777', '5511988887776'), false);
  assert.equal(samePhone('5511988887777', '552188887777'), false); // outro DDD
  assert.equal(samePhone('14155550123', '4155550123'), false); // fora do Brasil, compara exato
  assert.equal(samePhone('', ''), false);
});
