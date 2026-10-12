import { describe, expect, it } from 'vitest';
import { FpsMeter, FrameGate, fitWidth } from '../../src/engine/capture/rate';

describe('FrameGate — ограничение частоты обработки', () => {
  it('пропускает не чаще maxFps', () => {
    const gate = new FrameGate(2); // интервал 500 мс
    const accepted: number[] = [];
    for (let t = 0; t <= 2000; t += 100) {
      if (gate.tryAcquire(t)) {
        accepted.push(t);
        gate.done();
      }
    }
    expect(accepted).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it('отбрасывает кадр, пока предыдущий в обработке', () => {
    const gate = new FrameGate(100);
    expect(gate.tryAcquire(0)).toBe(true);
    expect(gate.tryAcquire(50)).toBe(false); // занят
    gate.done();
    expect(gate.tryAcquire(60)).toBe(true);
  });

  it('reset снимает блокировку', () => {
    const gate = new FrameGate(1);
    gate.tryAcquire(0);
    gate.reset();
    expect(gate.tryAcquire(1)).toBe(true);
  });
});

describe('FpsMeter', () => {
  it('считает частоту в окне', () => {
    const m = new FpsMeter(3000);
    for (let t = 0; t <= 2000; t += 200) m.tick(t); // 5 к/с
    expect(m.fps(2000)).toBeCloseTo(5, 5);
  });

  it('забывает старые отметки', () => {
    const m = new FpsMeter(1000);
    m.tick(0);
    m.tick(100);
    expect(m.fps(5000)).toBe(0);
  });
});

describe('fitWidth — масштабирование', () => {
  it('не увеличивает маленькие кадры', () => {
    expect(fitWidth(1280, 720, 1920)).toEqual({ width: 1280, height: 720 });
  });
  it('уменьшает с сохранением пропорций', () => {
    expect(fitWidth(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 });
  });
  it('на некорректном входе возвращает нули, а не выдумывает размер', () => {
    expect(fitWidth(0, 720, 1920)).toEqual({ width: 0, height: 0 });
  });
});
