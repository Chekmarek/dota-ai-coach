// Координаты аванпостов (npc_dota_watch_tower) из файлов Dota 2 → src/data/outposts.json. Только для разработчика,
// только чтение архива карты (maps/dota.vpk → maps/dota/entities/default_ents.vents_c). Коуч файлы игры не читает.
//   node scripts/extract-outposts.mjs ["…/dota 2 beta"]
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVpkDir, readVpkFile } from './vpk.mjs';
import { readKV3, resourceBlock } from './kv3.mjs';

const dota = process.argv[2] ?? 'C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta';
const root = join(import.meta.dirname, '..');
const patch = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8')).patch;
const vpk = readVpkDir(join(dota, 'game/dota/maps/dota.vpk'));
const ents = readKV3(resourceBlock(readVpkFile(vpk, 'maps/dota/entities/default_ents.vents_c'), 'DATA')).m_entityKeyValues;
const outposts = ents
  .map((e) => e.keyValues3Data?.values ?? {})
  .filter((v) => v.classname === 'npc_dota_watch_tower')
  .map((v) => ({ id: String(v.targetname).replace('[PR#]', ''), x: Math.round(v.origin[0]), y: Math.round(v.origin[1]) }));
// Проверка разбора: на карте 22 башни и 2 трона — иначе файл прочитан неверно
const count = (c) => ents.filter((e) => e.keyValues3Data?.values?.classname === c).length;
if (outposts.length !== 2 || count('npc_dota_tower') !== 22 || count('npc_dota_fort') !== 2) throw new Error(`Неожиданная карта: аванпостов ${outposts.length}, башен ${count('npc_dota_tower')}`);
const out = {
  patch,
  source: { name: 'Файлы Dota 2: maps/dota.vpk → maps/dota/entities/default_ents.vents_c (npc_dota_watch_tower)', extractedAt: new Date().toISOString().slice(0, 10) },
  noteRu: 'Координаты мира (как xpos/ypos в GSI). Чей аванпост сейчас, GSI игрока не сообщает.',
  outposts,
};
writeFileSync(join(root, 'src/data/outposts.json'), JSON.stringify(out, null, 1) + '\n');
console.log(out);
