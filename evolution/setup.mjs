// Gera as chaves da Evolution API (evolution/.env) e configura o monitor (.env na raiz).
// Rode uma vez:  npm run evolution:setup
// Se a Evolution já foi instalada (o banco dela existe no Docker) e o evolution/.env sumiu, as chaves
// são recuperadas do container em vez de geradas de novo: chaves novas não abririam o banco antigo.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';

const evoEnv = new URL('./.env', import.meta.url);
const rootEnv = new URL('../.env', import.meta.url);
// Nomes criados pelo Docker Compose a partir de "name: evolution" (docker-compose.yml).
const DB_VOLUME = 'evolution_postgres_data';
const SESSION_VOLUME = 'evolution_evolution_instances';
const API_CONTAINER = 'evolution-api-1';
const secret = () => randomBytes(24).toString('hex');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function docker(...args) {
  try {
    const out = execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch {
    return { ok: false };
  }
}

/** Chaves da Evolution já instalada, ou null se for uma instalação nova. Nunca imprime os valores. */
function existingKeys() {
  const volumes = docker('volume', 'ls', '-q', '--filter', `name=^${DB_VOLUME}$`);
  if (!volumes.ok) fail('Não consegui falar com o Docker. Abra o Docker Desktop (ou instale) e rode de novo.');
  if (volumes.out !== DB_VOLUME) return null;

  const inspect = docker('inspect', '--format', '{{json .Config.Env}}', API_CONTAINER);
  const env = inspect.ok
    ? Object.fromEntries(JSON.parse(inspect.out).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
    : {};
  if (!env.AUTHENTICATION_API_KEY || !env.POSTGRES_PASSWORD) {
    fail(
      [
        `O banco da Evolution já existe no Docker (volume ${DB_VOLUME}), mas o evolution/.env sumiu`,
        `e não deu para recuperar as chaves do container ${API_CONTAINER}. Chaves novas não abririam esse banco.`,
        '',
        'Escolha uma opção:',
        '  1. Restaure o evolution/.env de um backup e rode este comando de novo.',
        '  2. Ou comece do zero (o WhatsApp vai precisar ser conectado de novo pelo QR code):',
        `       npm run evolution:down && docker volume rm ${DB_VOLUME} ${SESSION_VOLUME}`,
        '     e depois rode este comando de novo.',
      ].join('\n'),
    );
  }
  return { apiKey: env.AUTHENTICATION_API_KEY, pgPass: env.POSTGRES_PASSWORD };
}

if (existsSync(evoEnv)) {
  console.log('evolution/.env já existe, mantendo as chaves atuais.');
} else {
  const recovered = existingKeys();
  const apiKey = recovered?.apiKey ?? secret();
  const pgPass = recovered?.pgPass ?? secret();
  writeFileSync(
    evoEnv,
    [
      `AUTHENTICATION_API_KEY=${apiKey}`,
      `POSTGRES_PASSWORD=${pgPass}`,
      'DATABASE_PROVIDER=postgresql',
      `DATABASE_CONNECTION_URI=postgresql://evolution:${pgPass}@postgres:5432/evolution?schema=public`,
      'DATABASE_CONNECTION_CLIENT_NAME=evolution',
      'DATABASE_SAVE_DATA_INSTANCE=true',
      'CACHE_REDIS_ENABLED=false',
      'CACHE_LOCAL_ENABLED=true',
      'SERVER_URL=http://localhost:8080',
      'DEL_INSTANCE=false',
      'CONFIG_SESSION_PHONE_CLIENT=Monitor de Precos',
      'CONFIG_SESSION_PHONE_NAME=Chrome',
      'LANGUAGE=pt-BR',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log(
    recovered
      ? 'evolution/.env recriado com as chaves da Evolution que já estava instalada.'
      : 'evolution/.env criado com chaves novas.',
  );
}

const apiKey = readFileSync(evoEnv, 'utf8').match(/^AUTHENTICATION_API_KEY=(.+)$/m)[1];
const current = existsSync(rootEnv) ? readFileSync(rootEnv, 'utf8') : '';
if (/^EVOLUTION_APIKEY=/m.test(current)) {
  console.log('.env do monitor já tem EVOLUTION_APIKEY, mantendo.');
} else {
  appendFileSync(
    rootEnv,
    [
      '',
      '# Evolution API (gerado por evolution/setup.mjs)',
      'EVOLUTION_URL=http://127.0.0.1:8080',
      `EVOLUTION_APIKEY=${apiKey}`,
      'EVOLUTION_INSTANCE=monitor-precos',
      '',
    ].join('\n'),
  );
  chmodSync(rootEnv, 0o600);
  console.log('.env do monitor configurado para a Evolution API.');
}
