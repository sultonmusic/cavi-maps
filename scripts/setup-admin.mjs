import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../server/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'security', 'admin.json');
try { await access(target); if (!process.argv.includes('--replace')) { console.error('Администратор уже настроен. Для смены пароля используйте --replace.'); process.exit(1); } } catch {}
const username = process.env.ATLAS_ADMIN_USERNAME || 'CaplineGroup-map';
let password = process.env.ATLAS_ADMIN_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) { console.error('Укажите ATLAS_ADMIN_PASSWORD через переменную окружения.'); process.exit(1); }
  process.stdout.write('Новый пароль (ввод скрыт): ');
  password = await new Promise(resolve => { let value = ''; process.stdin.setRawMode(true); process.stdin.resume(); const listener = data => { for (const ch of data.toString()) { if (ch === '\u0003') process.exit(130); if (ch === '\r' || ch === '\n') { process.stdin.off('data', listener); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(value); return; } if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else if (ch >= ' ') value += ch; } }; process.stdin.on('data', listener); });
}
const credentials = { username, ...await hashPassword(password), createdAt: new Date().toISOString() };
password = undefined;
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(credentials, null, 2), { mode: 0o600 });
console.log(`Локальный администратор ${username} настроен. Пароль хранится только как scrypt-хеш.`);
