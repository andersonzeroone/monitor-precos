// Instala o monitor como serviço do macOS (launchd): sobe sozinho quando você entra
// no Mac e volta se cair. Uso: npm run service:install | npm run service:uninstall
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('Este script só funciona no macOS (launchd).');
  process.exit(1);
}

const LABEL = 'com.monitor-precos';
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const service = `gui/${userInfo().uid}/${LABEL}`;
const logFile = join(project, 'data', 'monitor.log');

const launchctl = (...args) => execFileSync('launchctl', args, { stdio: 'pipe' });
const isLoaded = () => {
  try {
    launchctl('print', service);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Para a versão instalada antes (se houver) e espera o launchd soltar o serviço.
if (isLoaded()) {
  launchctl('bootout', service);
  for (let i = 0; i < 50 && isLoaded(); i++) await sleep(100);
}

if (process.argv[2] === 'uninstall') {
  rmSync(plistPath, { force: true });
  console.log('Serviço removido: o monitor parou e não sobe mais sozinho.');
  process.exit(0);
}

// Outro monitor na mesma porta (ex.: `npm start` num terminal) faria o serviço
// cair e reiniciar sem parar.
try {
  process.loadEnvFile(join(project, '.env'));
} catch {
  // sem .env: usa os padrões
}
const host = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1';
const port = Number(process.env.PORT || 3000);
await sleep(500);
const portBusy = await new Promise((resolve) => {
  const socket = createConnection({ host, port });
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});
if (portBusy) {
  console.error(`Já tem algo rodando na porta ${port}. Pare o monitor do terminal (Ctrl+C) e rode de novo.`);
  process.exit(1);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// caffeinate -i impede o Mac de dormir por inatividade enquanto o monitor roda.
const args = ['/usr/bin/caffeinate', '-i', process.execPath, '--disable-warning=ExperimentalWarning', 'src/server.js'];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(project)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;

mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(plistPath, plist);
launchctl('bootstrap', `gui/${userInfo().uid}`, plistPath);

console.log(`Serviço instalado: o monitor sobe sozinho quando você entra no Mac e volta se cair.
Painel: http://${host}:${port}
Log:    ${logFile}
Node:   ${process.execPath} (se trocar a versão do Node, rode npm run service:install de novo)`);
