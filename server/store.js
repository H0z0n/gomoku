// Простое хранилище в JSON-файле. Для игры на двоих (и даже на сотни людей) этого хватает.
import fs from 'node:fs';
import path from 'node:path';

export const data = { games: {}, users: {}, scores: {} };

let file = null;
let timer = null;

export function load(filePath) {
  file = path.resolve(filePath);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.games = raw.games || {};
    data.users = raw.users || {};
    data.scores = raw.scores || {};
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // битый файл не перезаписываем молча
  }
}

/** Отложенная запись: несколько изменений подряд сохраняются одной записью. */
export function save() {
  if (!timer) timer = setTimeout(flush, 500);
}

export function flush() {
  clearTimeout(timer);
  timer = null;
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
