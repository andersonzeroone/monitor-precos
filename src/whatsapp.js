// Envio de WhatsApp. O provedor é escolhido no painel; credenciais ficam no arquivo .env.

export const PROVIDERS = {
  console: { label: 'Teste (só mostra no terminal)', env: [] },
  callmebot: { label: 'CallMeBot (grátis, apikey por número)', env: [] },
  evolution: { label: 'Evolution API (seu próprio número via QR code)', env: ['EVOLUTION_URL', 'EVOLUTION_APIKEY', 'EVOLUTION_INSTANCE'] },
  cloudapi: { label: 'WhatsApp Cloud API (oficial da Meta)', env: ['WA_CLOUD_TOKEN', 'WA_CLOUD_PHONE_ID'] },
};

export function missingEnv(provider) {
  return (PROVIDERS[provider]?.env ?? []).filter((k) => !process.env[k]);
}

/** Aceita "(11) 98888-7777", "+55 11 98888-7777" etc. Sem DDI, assume Brasil (55). */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  if (full.length < 12 || full.length > 15) throw new Error('Número inválido: use DDD + número (ex.: 11 98888-7777)');
  return full;
}

/** Mesmo número? No Brasil ignora o 9 extra do celular, que o WhatsApp às vezes guarda sem ele. */
export function samePhone(a, b) {
  const key = (p) => {
    const d = String(p ?? '').replace(/\D/g, '');
    return /^55\d{2}9\d{8}$/.test(d) ? d.slice(0, 4) + d.slice(5) : d;
  };
  return key(a) !== '' && key(a) === key(b);
}

async function readError(res) {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}: ${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

// ---------- Evolution API: status e conexão por QR code ----------

async function evolution(method, path, body, timeoutMs = 10_000) {
  const missing = missingEnv('evolution');
  if (missing.length) throw new Error(`Faltam variáveis no .env: ${missing.join(', ')}`);
  const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
  const res = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_APIKEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const evoInstance = () => encodeURIComponent(process.env.EVOLUTION_INSTANCE);
const evoError = (data) => [data?.response?.message ?? data?.message ?? data?.error ?? data].flat().join(' ').slice(0, 200);

/**
 * state: open | connecting | close | not_found | offline | error.
 * Conectado, traz também `number` e `name` do WhatsApp de onde saem os alertas.
 */
export async function evolutionStatus() {
  try {
    const { status, data } = await evolution('GET', `/instance/connectionState/${evoInstance()}`, null, 4000);
    if (status === 404) return { state: 'not_found' };
    if (status === 401 || status === 403) return { state: 'error', error: 'A Evolution recusou a EVOLUTION_APIKEY do .env' };
    if (status !== 200) return { state: 'error', error: `Evolution respondeu HTTP ${status}: ${evoError(data)}` };
    const state = data?.instance?.state ?? 'unknown';
    return state === 'open' ? { state, ...(await evolutionOwner()) } : { state };
  } catch (err) {
    if (err.message.startsWith('Faltam')) return { state: 'error', error: err.message };
    return { state: 'offline', error: 'A Evolution API não está respondendo. O Docker está aberto? (npm run evolution:up)' };
  }
}

async function evolutionOwner() {
  try {
    const { status, data } = await evolution('GET', `/instance/fetchInstances?instanceName=${evoInstance()}`, null, 4000);
    const inst = status === 200 && Array.isArray(data) ? data[0] : null;
    // v2.2+ devolve o registro direto; a v2.1 documentada embrulha em { instance: { owner } }.
    const jid = inst?.ownerJid ?? inst?.instance?.owner ?? '';
    return { number: /^(\d{10,15})[:@]/.exec(jid)?.[1] ?? null, name: inst?.profileName ?? inst?.instance?.profileName ?? null };
  } catch {
    return {}; // sem o número, o painel só mostra "conectado"
  }
}

/** Desconecta o número atual, para conectar outro pelo QR code. */
export async function evolutionLogout() {
  const { status, data } = await evolution('DELETE', `/instance/logout/${evoInstance()}`);
  if (status >= 300) throw new Error(`Evolution: ${evoError(data)}`);
}

/** Cria a instância se precisar e devolve o QR code (data:image/png;base64,...). */
export async function evolutionConnect() {
  const current = await evolutionStatus();
  if (current.state === 'open') return { connected: true };
  if (current.state === 'offline' || current.state === 'error') throw new Error(current.error);

  if (current.state === 'not_found') {
    const { status, data } = await evolution('POST', '/instance/create', {
      instanceName: process.env.EVOLUTION_INSTANCE,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    });
    if (status >= 300) throw new Error(`Não consegui criar a instância na Evolution: ${evoError(data)}`);
    if (data?.qrcode?.base64) return { qr: data.qrcode.base64 };
  }

  const { status, data } = await evolution('GET', `/instance/connect/${evoInstance()}`);
  if (status >= 300) throw new Error(`Evolution: ${evoError(data)}`);
  if (data?.instance?.state === 'open') return { connected: true };
  if (!data?.base64) throw new Error('A Evolution ainda não gerou o QR code. Tente de novo em alguns segundos.');
  return { qr: data.base64 };
}

export async function sendWhatsApp(provider, contact, text) {
  const signal = AbortSignal.timeout(30_000);
  const missing = missingEnv(provider);
  if (missing.length) throw new Error(`Faltam variáveis no .env: ${missing.join(', ')}`);

  switch (provider) {
    case 'console':
      console.log(`\n[whatsapp:teste] para ${contact.name} (+${contact.phone}):\n${text}\n`);
      return 'ok (modo teste, veja o terminal)';

    case 'callmebot': {
      if (!contact.apikey) throw new Error('contato sem apikey do CallMeBot');
      const url = new URL('https://api.callmebot.com/whatsapp.php');
      url.searchParams.set('phone', `+${contact.phone}`);
      url.searchParams.set('text', text);
      url.searchParams.set('apikey', contact.apikey);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (/invalid|error|not allowed|paused|blocked/i.test(body)) throw new Error(body.slice(0, 200));
      return 'ok';
    }

    case 'evolution': {
      const base = process.env.EVOLUTION_URL.replace(/\/+$/, '');
      const instance = encodeURIComponent(process.env.EVOLUTION_INSTANCE);
      const res = await fetch(`${base}/message/sendText/${instance}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_APIKEY },
        body: JSON.stringify({ number: contact.phone, text, linkPreview: false }),
      });
      if (!res.ok) throw new Error(await readError(res));
      return 'ok';
    }

    case 'cloudapi': {
      const version = process.env.WA_CLOUD_API_VERSION || 'v23.0';
      const res = await fetch(`https://graph.facebook.com/${version}/${process.env.WA_CLOUD_PHONE_ID}/messages`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WA_CLOUD_TOKEN}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: contact.phone,
          type: 'text',
          text: { body: text, preview_url: false },
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      return 'ok';
    }

    default:
      throw new Error(`Provedor desconhecido: ${provider}`);
  }
}
