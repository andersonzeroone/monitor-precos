import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/Sao_Paulo';
const { computeNextRun, blackFriday, blackFridayWindows, parseDailyTimes } = await import('../src/schedule.js');

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('Black Friday cai na sexta depois da 4ª quinta de novembro', () => {
  assert.equal(blackFriday(2026).toDateString(), local(2026, 11, 27).toDateString());
  assert.equal(blackFriday(2025).toDateString(), local(2025, 11, 28).toDateString());
  assert.equal(blackFriday(2027).toDateString(), local(2027, 11, 26).toDateString());
});

test('janelas padrão apontam para a próxima Black Friday', () => {
  const [madrugada] = blackFridayWindows(local(2026, 11, 15));
  assert.equal(new Date(madrugada.starts_at).getTime(), local(2026, 11, 26, 22).getTime());
  assert.equal(new Date(madrugada.ends_at).getTime(), local(2026, 11, 27, 6).getTime());
  const [next] = blackFridayWindows(local(2026, 12, 10));
  assert.equal(new Date(next.starts_at).getFullYear(), 2027);
});

test('horários diários inválidos geram erro', () => {
  assert.deepEqual(parseDailyTimes('08:00, 20:30'), [[8, 0], [20, 30]]);
  assert.throws(() => parseDailyTimes('25:00'), /inválido/);
  assert.throws(() => parseDailyTimes('8h'), /inválido/);
});

const windows = [
  { starts_at: local(2026, 11, 26, 22).toISOString(), ends_at: local(2026, 11, 27, 6).toISOString(), interval_min: 5 },
];

test('fora da janela: próximo horário diário', () => {
  const next = computeNextRun({ now: local(2026, 11, 20, 9), dailyTimes: '08:00,20:00', windows, lastRunAt: null });
  assert.equal(next.getTime(), local(2026, 11, 20, 20).getTime());
});

test('janela começando antes do próximo horário diário', () => {
  const next = computeNextRun({ now: local(2026, 11, 26, 21), dailyTimes: '08:00,20:00', windows, lastRunAt: null });
  assert.equal(next.getTime(), local(2026, 11, 26, 22).getTime());
});

test('dentro da janela: última execução + intervalo', () => {
  const lastRunAt = local(2026, 11, 27, 1, 0).toISOString();
  const next = computeNextRun({ now: local(2026, 11, 27, 1, 1), dailyTimes: '08:00', windows, lastRunAt });
  assert.equal(next.getTime(), local(2026, 11, 27, 1, 5).getTime());
});

test('entrou na janela sem ter rodado nela: roda já', () => {
  const now = local(2026, 11, 27, 0, 30);
  const next = computeNextRun({ now, dailyTimes: '08:00', windows, lastRunAt: local(2026, 11, 26, 20).toISOString() });
  assert.equal(next.getTime(), now.getTime());
});

test('janela termina: volta aos horários diários', () => {
  const lastRunAt = local(2026, 11, 27, 5, 58).toISOString();
  const next = computeNextRun({ now: local(2026, 11, 27, 5, 59), dailyTimes: '08:00', windows, lastRunAt });
  assert.equal(next.getTime(), local(2026, 11, 27, 8).getTime());
});

test('sem horários nem janelas: nada agendado', () => {
  assert.equal(computeNextRun({ now: new Date(), dailyTimes: '', windows: [], lastRunAt: null }), null);
});
