// Список имён героев для распознавания (берётся из базы знаний текущего патча).
//   node scripts/make-hero-names.mjs   →  src/data/hero-names.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { patch } = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8'));
const heroes = JSON.parse(readFileSync(join(root, 'resources/data/kb', patch, 'heroes.json'), 'utf8'));
const names = heroes.map((h) => ({ id: h.id, key: h.key, name: h.name })).sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(root, 'src/data/hero-names.json'), JSON.stringify({ patch, names }, null, 1));
console.log(`Имён героев: ${names.length} (патч ${patch})`);
