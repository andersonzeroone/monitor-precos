// Agenda: horários diários normais + "janelas intensivas" (ex.: madrugada da Black Friday)
// em que a verificação roda a cada X minutos. Tudo no fuso do servidor (TZ).

const MIN = 60_000;

export function parseDailyTimes(str) {
  return String(str ?? '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`Horário inválido: "${t}" (use HH:MM)`);
      return [+m[1], +m[2]];
    });
}

export function activeWindows(windows, now) {
  return windows.filter((w) => new Date(w.starts_at) <= now && now < new Date(w.ends_at));
}

/**
 * Próxima execução: o menor entre o próximo horário diário, o início da próxima janela
 * e (se estiver dentro de uma janela) a última execução + intervalo.
 */
export function computeNextRun({ now, lastRunAt, dailyTimes, windows }) {
  const candidates = [];

  for (const [h, m] of parseDailyTimes(dailyTimes)) {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    candidates.push(d);
  }

  for (const w of windows) {
    const start = new Date(w.starts_at);
    const end = new Date(w.ends_at);
    if (now < start) {
      candidates.push(start);
    } else if (now < end) {
      const last = lastRunAt ? new Date(lastRunAt) : null;
      const next = last && last >= start ? new Date(last.getTime() + w.interval_min * MIN) : now;
      if (next < end) candidates.push(next < now ? now : next);
    }
  }

  if (!candidates.length) return null;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

/** Data (local) da Black Friday: sexta-feira após a 4ª quinta-feira de novembro. */
export function blackFriday(year) {
  const firstDow = new Date(year, 10, 1).getDay();
  const firstThursday = 1 + ((4 - firstDow + 7) % 7);
  return new Date(year, 10, firstThursday + 21 + 1);
}

/** Janelas padrão para a próxima Black Friday (usadas na primeira execução). */
export function blackFridayWindows(now) {
  let bf = blackFriday(now.getFullYear());
  const cyberMondayEnd = new Date(bf.getFullYear(), bf.getMonth(), bf.getDate() + 4);
  if (now >= cyberMondayEnd) bf = blackFriday(now.getFullYear() + 1);

  const at = (dayOffset, hour) => new Date(bf.getFullYear(), bf.getMonth(), bf.getDate() + dayOffset, hour).toISOString();
  return [
    { label: 'Black Friday — madrugada', starts_at: at(-1, 22), ends_at: at(0, 6), interval_min: 5 },
    { label: 'Black Friday — dia', starts_at: at(0, 6), ends_at: at(1, 0), interval_min: 15 },
    { label: 'Cyber Monday', starts_at: at(3, 0), ends_at: at(4, 0), interval_min: 30 },
  ];
}
