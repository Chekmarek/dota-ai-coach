// Что скачивает кнопка «Скачать локальный ИИ»: точные версии и SHA-256 (проверяются после скачивания).
// Файлы не лежат в репозитории и в app.asar — только в <папка данных>/ai/.
//
// llama.cpp: официальная сборка ggml-org для Windows CPU x64. В архиве несколько вариантов ggml-cpu-*.dll
// (x64, sse42, sandybridge/AVX, haswell/AVX2, skylakex/AVX-512 …): llama-server сам выбирает лучший для процессора,
// поэтому AVX2 используется, где он есть, а без него работает запасной вариант.
// Модели Qwen3 (Apache-2.0), квантование Q4_K_M:
//  - 4B — официальный репозиторий Qwen;
//  - 1.7B — у Qwen в GGUF только Q8_0 (1,8 ГБ), поэтому Q4_K_M из unsloth/Qwen3-1.7B-GGUF (та же модель и лицензия).
// Ссылки закреплены на коммит репозитория Hugging Face (resolve/<sha>/…), а не на «main».
import type { AiLocalModel } from '@shared/schemas/settings';

export interface PinnedFile {
  url: string;
  /** Имя файла в <данные>/ai/ */
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export const LLAMA_CPP_BUILD = 'b11635';

export const RUNTIME: PinnedFile & { exe: string; dir: string } = {
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_BUILD}/llama-${LLAMA_CPP_BUILD}-bin-win-cpu-x64.zip`,
  fileName: `llama-${LLAMA_CPP_BUILD}-bin-win-cpu-x64.zip`,
  sizeBytes: 19_519_555,
  sha256: 'cdd3e89898f1bd494c7e74a6fa8d955d91a946392e55250bf91a1835bdb236dc',
  dir: `llama-${LLAMA_CPP_BUILD}`,
  exe: 'llama-server.exe',
};

export interface PinnedModel extends PinnedFile {
  id: AiLocalModel;
  nameRu: string;
  license: string;
  source: string;
}

export const MODELS: Record<AiLocalModel, PinnedModel> = {
  'qwen3-1.7b': {
    id: 'qwen3-1.7b',
    nameRu: 'Qwen3 1.7B (быстрее, по умолчанию)',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf',
    fileName: 'Qwen3-1.7B-Q4_K_M.gguf',
    sizeBytes: 1_107_409_472,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    license: 'Apache-2.0',
    source: 'unsloth/Qwen3-1.7B-GGUF (модель Qwen/Qwen3-1.7B)',
  },
  'qwen3-4b': {
    id: 'qwen3-4b',
    nameRu: 'Qwen3 4B (умнее, медленнее)',
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf',
    fileName: 'Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2_497_280_256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    license: 'Apache-2.0',
    source: 'Qwen/Qwen3-4B-GGUF',
  },
};

/** Параметры llama-server (решение владельца: CPU, контекст ≤ 4096, половина логических ядер, не меньше 2) */
export const CONTEXT_TOKENS = 4096;
export const IDLE_STOP_MS = 5 * 60_000;
export function threadsFor(logicalCores: number): number {
  return Math.max(2, Math.floor(logicalCores / 2));
}
