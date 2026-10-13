export interface SessionEntry {
  t: number;
  body: Record<string, unknown>;
}
export function parseSession(text: string): SessionEntry[];
export function defaultDataDir(): string;
export function readCoachSettings(dataDir: string): { port: number | null; token: string | null };
export function replaySession(
  entries: SessionEntry[],
  opts: {
    url: string;
    token: string;
    speed?: number;
    post?: (url: string, body: Record<string, unknown>) => Promise<number>;
    sleep?: (ms: number) => Promise<void>;
    onSent?: (code: number, done: number, total: number) => void;
  },
): Promise<{ sent: number; failed: number }>;
