// Кадр превью — на canvas, а не <img src="blob:…">: Chromium держит в кэше документа байты каждой картинки, загруженной
// по blob-ссылке, и после revokeObjectURL. На «Разборе записи» (2 кадра/с) окно росло на ~10 МБ в минуту без предела;
// canvas + ImageBitmap (сразу закрывается) — память ровная (замер этапа 4, docs/LIMITATIONS.md).
import { useEffect, useRef } from 'react';

/** Рисует JPEG на canvas; isStale() — пришёл кадр новее, этот уже не рисуем */
export async function drawBlob(canvas: HTMLCanvasElement, blob: Blob, isStale: () => boolean = () => false): Promise<void> {
  let bm: ImageBitmap;
  try {
    bm = await createImageBitmap(blob);
  } catch {
    return; // битый кадр — оставляем прежний
  }
  try {
    if (isStale()) return;
    if (canvas.width !== bm.width) canvas.width = bm.width;
    if (canvas.height !== bm.height) canvas.height = bm.height;
    canvas.getContext('2d')?.drawImage(bm, 0, 0);
  } finally {
    bm.close();
  }
}

export function PreviewImage({ blob, label, testId, className }: { blob: Blob; label: string; testId?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let stale = false;
    if (ref.current) void drawBlob(ref.current, blob, () => stale);
    return () => {
      stale = true;
    };
  }, [blob]);
  return <canvas ref={ref} role="img" aria-label={label} data-testid={testId} className={className} />;
}
