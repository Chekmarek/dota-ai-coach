// Точки карты из файлов Dota 2 (maps/dota.vpk → default_ents.vents_c) → src/data/map-points.json:
// руны силы и богатства, логово Рошана, Мучитель, лотосы, источники опыта, башни (сторона, уровень, линия).
// Только для разработчика, только чтение архива карты; коуч файлы игры не читает. Проверка разбора: 22 башни, 2 трона.
//   node scripts/extract-map-points.mjs ["…/dota 2 beta"]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVpkDir, readVpkFile } from './vpk.mjs';
import { readKV3, resourceBlock } from './kv3.mjs';

const dota = process.argv[2] ?? 'C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta';
const root = join(import.meta.dirname, '..');
const patch = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8')).patch;
const vpk = readVpkDir(join(dota, 'game/dota/maps/dota.vpk'));
const ents = readKV3(resourceBlock(readVpkFile(vpk, 'maps/dota/entities/default_ents.vents_c'), 'DATA')).m_entityKeyValues.map((e) => e.keyValues3Data?.values ?? {});
const pt = (v) => ({ x: Math.round(v.origin[0]), y: Math.round(v.origin[1]) });
const of = (cls) => ents.filter((v) => v.classname === cls);
const towers = of('npc_dota_tower').map((v) => {
  const name = String(v.targetname ?? '');
  const m = /dota_(goodguys|badguys)_tower(\d)_(top|mid|bot)?/.exec(name);
  return m ? { team: m[1] === 'goodguys' ? 'radiant' : 'dire', tier: Number(m[2]), lane: m[3] ?? null, ...pt(v) } : null;
});
if (towers.length !== 22 || towers.some((t) => t === null) || of('npc_dota_fort').length !== 2) throw new Error(`Неожиданная карта: башен ${towers.length}`);
const out = {
  patch,
  source: { name: 'Файлы Dota 2: maps/dota.vpk → maps/dota/entities/default_ents.vents_c', extractedAt: new Date().toISOString().slice(0, 10) },
  noteRu: 'Координаты мира (как xpos/ypos в GSI).',
  runes: { power: of('dota_item_rune_spawner_powerup').map(pt), bounty: of('dota_item_rune_spawner_bounty').map(pt) },
  roshan: of('npc_dota_roshan_spawner').map(pt),
  tormentor: of('npc_dota_miniboss_spawner').map(pt),
  lotus: of('npc_dota_lotus_pool').map(pt),
  wisdom: of('npc_dota_xp_fountain').map(pt),
  towers,
};
writeFileSync(join(root, 'src/data/map-points.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`руны силы ${out.runes.power.length}, богатства ${out.runes.bounty.length}, Рошан ${out.roshan.length}, башен ${towers.length}`);
