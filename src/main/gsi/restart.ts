// Перезапуск приёмника GSI строго по одному (без Electron — проверяется unit-тестом).
// Раньше два изменения настроек подряд могли запустить второй приёмник, пока первый ещё останавливался,
// и старый оставался слушать порт. Теперь: пока идёт перезапуск, новые запросы ждут; выполняется последний
// запрошенный порт; прежний приёмник всегда останавливается до запуска нового.

export interface Restartable {
  stop(): Promise<void>;
}

export class SerialRestarter<S extends Restartable> {
  private current: S | null = null;
  private running: Promise<void> | null = null;
  private wanted: number | null = null;

  constructor(
    private readonly create: (port: number) => S,
    private readonly start: (server: S) => Promise<unknown>,
  ) {}

  /** Работающий (или запускающийся) приёмник; null — остановлен */
  get server(): S | null {
    return this.current;
  }

  /** Перезапустить на порту port. Обещание выполняется, когда все накопившиеся перезапуски закончены */
  restart(port: number): Promise<void> {
    this.wanted = port;
    if (!this.running) {
      this.running = this.loop().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Остановить приёмник (после текущего перезапуска, если он идёт) */
  async stop(): Promise<void> {
    this.wanted = null;
    if (this.running) await this.running;
    const s = this.current;
    this.current = null;
    await s?.stop();
  }

  private async loop(): Promise<void> {
    while (this.wanted !== null) {
      const port = this.wanted;
      this.wanted = null;
      const old = this.current;
      this.current = null;
      if (old) await old.stop();
      const s = this.create(port);
      this.current = s;
      await this.start(s);
    }
  }
}
