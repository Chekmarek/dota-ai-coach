import { z } from 'zod';
import type { CaptureStatus } from '../types/capture';
import type { HudReading } from '../../core/vision/recognize-hud.ts';

// Протокол между окном интерфейса и скрытым окном движка (через MessagePort).
// Кадры целиком по нему НЕ ходят — только статус и сжатые превью с ограниченной частотой.

const replaySourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image-folder'),
    id: z.string().min(1).max(64),
    label: z.string().max(500),
    frames: z.array(z.string().startsWith('dcmedia://')).min(1).max(100_000),
  }),
  z.object({
    kind: z.literal('video-file'),
    id: z.string().min(1).max(64),
    label: z.string().max(500),
    url: z.string().startsWith('dcmedia://'),
  }),
]);

export const uiToEngineSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('replay:start'),
    options: z.object({
      source: replaySourceSchema,
      fps: z.number().min(0.2).max(30),
      maxWidth: z.number().int().min(320).max(3840),
      processingFpsCap: z.number().min(0.2).max(30),
      previewFps: z.number().min(0.2).max(10),
      loop: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('replay:pause') }),
  z.object({ type: z.literal('replay:resume') }),
  z.object({ type: z.literal('replay:stop') }),
  // Живой захват окна Dota 2 (только наблюдение)
  z.object({
    type: z.literal('live:start'),
    options: z.object({
      fps: z.number().min(1).max(30),
      maxWidth: z.number().int().min(320).max(3840),
      processingFpsCap: z.number().min(0.2).max(30),
      previewFps: z.number().min(0.2).max(10),
    }),
  }),
  z.object({ type: z.literal('live:stop') }),
  // Окно интерфейса скрыто — превью не кодируем, обработка кадров продолжается
  z.object({ type: z.literal('ui:visibility'), visible: z.boolean() }),
  z.object({ type: z.literal('status:request') }),
]);

export type UiToEngine = z.infer<typeof uiToEngineSchema>;

export interface PreviewMessage {
  type: 'preview';
  /** JPEG уменьшенного кадра */
  jpeg: ArrayBuffer;
  width: number;
  height: number;
  frameIndex: number;
  sourceTimeMs: number | null;
}

export interface VisionMessage {
  type: 'vision';
  reading: HudReading;
  frameIndex: number;
  sourceTimeMs: number | null;
}

export type EngineToUi = { type: 'status'; status: CaptureStatus } | PreviewMessage | VisionMessage;
