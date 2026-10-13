// Справочники для перевода GSI в чтение коуча: имена предметов и героев — из тех же данных, что и у зрения.
import { mapGsi, type GsiReading } from '@core/gsi/index.ts';
import itemTemplatesJson from '../data/item-templates.json';
import heroNamesJson from '../data/hero-names.json';

const itemNames = new Map<string, string>();
for (const it of (itemTemplatesJson as unknown as { items: { key: string; name: string; aliases?: string[] }[] }).items) {
  itemNames.set(it.key, it.name);
}
const heroes = new Map<string, { id: number; name: string }>();
for (const h of heroNamesJson.names as { id: number; key: string; name: string }[]) heroes.set(h.key, { id: h.id, name: h.name });

/** Тело GSI → чтение; null — не матч своего героя (меню, наблюдатель) или мусор */
export function readGsi(body: unknown): GsiReading | null {
  return mapGsi(
    body,
    (key) => itemNames.get(key),
    (key) => heroes.get(key),
  );
}
