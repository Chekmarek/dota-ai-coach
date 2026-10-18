// Чтение двоичного KV3 (версии 4–5) из ресурсов Dota 2 (*.vents_c и т. п.) — только для скриптов разработчика,
// как vpk.mjs. Сам коуч файлы игры не читает. Раскладка — по ValveResourceFormat (BinaryKV3.cs, MIT):
// заголовок → буфер 1 (строки) → буфер 2 (длины объектов, полосы 1/2/4/8 байт, типы) → двоичные блоки.
// Сжатие: без сжатия или ZSTD (встроен в Node 24: zlib.zstdDecompressSync). LZ4 не поддержан — честная ошибка.
import { zstdDecompressSync } from 'node:zlib';

const T = {
  NULL: 1, BOOLEAN: 2, INT64: 3, UINT64: 4, DOUBLE: 5, STRING: 6, BINARY_BLOB: 7, ARRAY: 8, OBJECT: 9, ARRAY_TYPED: 10,
  INT32: 11, UINT32: 12, BOOLEAN_TRUE: 13, BOOLEAN_FALSE: 14, INT64_ZERO: 15, INT64_ONE: 16, DOUBLE_ZERO: 17, DOUBLE_ONE: 18,
  FLOAT: 19, INT16: 20, UINT16: 21, INT8: 22, UINT8: 23, ARRAY_TYPE_BYTE_LENGTH: 24, ARRAY_TYPE_AUXILIARY_BUFFER: 25,
  UINT32_ZERO: 26, UINT32_ONE: 27,
};

/** Полоса байтов с курсором */
class Lane {
  constructor(buf, start = 0, end = buf?.length ?? 0) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  take(n) {
    if (this.pos + n > this.end) throw new Error(`KV3: полоса кончилась (нужно ${n}, осталось ${this.end - this.pos})`);
    const p = this.pos;
    this.pos += n;
    return p;
  }
  u8() { return this.buf.readUInt8(this.take(1)); }
  i8() { return this.buf.readInt8(this.take(1)); }
  i16() { return this.buf.readInt16LE(this.take(2)); }
  u16() { return this.buf.readUInt16LE(this.take(2)); }
  i32() { return this.buf.readInt32LE(this.take(4)); }
  u32() { return this.buf.readUInt32LE(this.take(4)); }
  f32() { return this.buf.readFloatLE(this.take(4)); }
  i64() { return Number(this.buf.readBigInt64LE(this.take(8))); }
  u64() { return Number(this.buf.readBigUInt64LE(this.take(8))); }
  f64() { return this.buf.readDoubleLE(this.take(8)); }
}

const align = (o, a) => Math.ceil(o / a) * a;

/** Блок DATA ресурса (*_c): смещение и размер блока по таблице блоков */
export function resourceBlock(file, name) {
  const blockOffset = 8 + file.readUInt32LE(8);
  const count = file.readUInt32LE(12);
  for (let i = 0; i < count; i++) {
    const p = blockOffset + i * 12;
    if (file.toString('latin1', p, p + 4) === name) return file.subarray(p + 4 + file.readUInt32LE(p + 4), p + 4 + file.readUInt32LE(p + 4) + file.readUInt32LE(p + 8));
  }
  throw new Error(`KV3: блока ${name} нет`);
}

/** Двоичный KV3 → обычный объект JS (числа, строки, массивы, объекты; двоичные блоки — Buffer) */
export function readKV3(data) {
  const r = new Lane(data);
  const magic = r.u32();
  const version = magic & 0xff;
  if ((magic & 0xffffff00) >>> 0 !== 0x4b563300 || version < 4 || version > 5) throw new Error(`KV3: поддержаны версии 4–5, а здесь ${magic.toString(16)}`);
  r.take(16); // GUID формата
  const compression = r.u32();
  r.u16(); // compressionDictionaryId
  r.u16(); // compressionFrameSize
  const countBytes1 = r.i32(), countBytes4 = r.i32(), countBytes8 = r.i32(), countTypes = r.i32();
  const countObjects = r.u16(); r.u16(); // countArrays
  r.i32(); // sizeUncompressedTotal
  const sizeCompressedTotal = r.i32(), countBlocks = r.i32(), sizeBinaryBlobs = r.i32();
  const countBytes2 = r.i32(); r.i32(); // sizeBlockCompressedSizesBytes
  let sizeU1 = 0, sizeC1 = 0, sizeU2 = 0, sizeC2 = 0, b2c1 = 0, b2c2 = 0, b2c4 = 0, b2c8 = 0, objects2 = countObjects;
  if (version >= 5) {
    sizeU1 = r.i32(); sizeC1 = r.i32(); sizeU2 = r.i32(); sizeC2 = r.i32();
    b2c1 = r.i32(); b2c2 = r.i32(); b2c4 = r.i32(); b2c8 = r.i32();
    r.i32(); objects2 = r.i32(); r.i32(); r.i32();
  } else throw new Error('KV3 v4: не нужен для сущностей карты — не реализовано');
  if (compression !== 0 && compression !== 2) throw new Error(`KV3: сжатие ${compression} (LZ4) не поддержано`);
  const chunk = (compSize, rawSize) => {
    if (compression === 0) return data.subarray(r.take(rawSize), r.pos);
    const c = data.subarray(r.take(compSize), r.pos);
    const out = zstdDecompressSync(c);
    if (out.length !== rawSize) throw new Error(`KV3: ZSTD дал ${out.length} байт вместо ${rawSize}`);
    return out;
  };
  // Буфер 1: полосы и строки
  const b1 = chunk(sizeC1, sizeU1);
  let o = 0;
  const lanes1 = {};
  lanes1.l1 = new Lane(b1, o, (o += countBytes1));
  if (countBytes2) { o = align(o, 2); lanes1.l2 = new Lane(b1, o, (o += countBytes2 * 2)); } else lanes1.l2 = new Lane(b1, o, o);
  if (countBytes4) { o = align(o, 4); lanes1.l4 = new Lane(b1, o, (o += countBytes4 * 4)); } else lanes1.l4 = new Lane(b1, o, o);
  if (countBytes8) { o = align(o, 8); lanes1.l8 = new Lane(b1, o, (o += countBytes8 * 8)); } else lanes1.l8 = new Lane(b1, o, o);
  const countStrings = lanes1.l4.i32();
  const strings = [];
  for (let i = 0; i < countStrings; i++) {
    const s = lanes1.l1.pos;
    const z = b1.indexOf(0, s);
    strings.push(b1.toString('utf8', s, z));
    lanes1.l1.pos = z + 1;
  }
  // Буфер 2: длины объектов, полосы, типы
  const b2 = chunk(sizeC2, sizeU2);
  o = 0;
  const objLen = new Lane(b2, 0, (o = objects2 * 4));
  const lanes2 = {};
  lanes2.l1 = new Lane(b2, o, (o += b2c1));
  if (b2c2) { o = align(o, 2); lanes2.l2 = new Lane(b2, o, (o += b2c2 * 2)); } else lanes2.l2 = new Lane(b2, o, o);
  if (b2c4) { o = align(o, 4); lanes2.l4 = new Lane(b2, o, (o += b2c4 * 4)); } else lanes2.l4 = new Lane(b2, o, o);
  if (b2c8) { o = align(o, 8); lanes2.l8 = new Lane(b2, o, (o += b2c8 * 8)); } else lanes2.l8 = new Lane(b2, o, o);
  const types = new Lane(b2, o, (o += countTypes));
  let blobLens = null, blobs = null;
  if (countBlocks > 0) {
    blobLens = new Lane(b2, o, (o += countBlocks * 4));
    if (b2.readUInt32LE(o) !== 0xffeedd00) throw new Error('KV3: нет метки после длин блоков');
    const sizeCBlobs = sizeCompressedTotal - sizeC1 - sizeC2;
    blobs = new Lane(chunk(sizeCBlobs, sizeBinaryBlobs));
  }
  const str = (id) => (id >= 0 && id < strings.length ? strings[id] : '');
  const readType = () => {
    let t = types.u8();
    if (t & 0x80) types.u8(); // флаг значения (resource, panorama и т. п.) — для координат не нужен
    if (t & 0x40) types.u8();
    return t & 0x3f;
  };
  const value = (t, lane) => {
    switch (t) {
      case T.NULL: return null;
      case T.BOOLEAN_TRUE: return true;
      case T.BOOLEAN_FALSE: return false;
      case T.INT64_ZERO: case T.DOUBLE_ZERO: case T.UINT32_ZERO: return 0;
      case T.INT64_ONE: case T.DOUBLE_ONE: case T.UINT32_ONE: return 1;
      case T.BOOLEAN: return lane.l1.u8() !== 0;
      case T.INT8: return lane.l1.i8();
      case T.UINT8: return lane.l1.u8();
      case T.INT16: return lane.l2.i16();
      case T.UINT16: return lane.l2.u16();
      case T.INT32: return lane.l4.i32();
      case T.UINT32: return lane.l4.u32();
      case T.FLOAT: return lane.l4.f32();
      case T.INT64: return lane.l8.i64();
      case T.UINT64: return lane.l8.u64();
      case T.DOUBLE: return lane.l8.f64();
      case T.STRING: return str(lanes2.l4.i32());
      case T.BINARY_BLOB: {
        const n = blobLens.i32();
        const p = blobs.take(n);
        return blobs.buf.subarray(p, p + n);
      }
      case T.ARRAY: {
        const n = lanes2.l4.i32();
        const a = [];
        for (let i = 0; i < n; i++) a.push(value(readType(), lanes2));
        return a;
      }
      case T.ARRAY_TYPED: case T.ARRAY_TYPE_BYTE_LENGTH: case T.ARRAY_TYPE_AUXILIARY_BUFFER: {
        const n = t === T.ARRAY_TYPED ? lanes2.l4.i32() : lanes2.l1.u8();
        const sub = readType();
        const el = t === T.ARRAY_TYPE_AUXILIARY_BUFFER ? lanes1 : lanes2;
        const a = [];
        for (let i = 0; i < n; i++) a.push(value(sub, el));
        return a;
      }
      case T.OBJECT: {
        const n = objLen.i32();
        const obj = {};
        for (let i = 0; i < n; i++) {
          const ct = readType();
          const name = str(lanes2.l4.i32());
          obj[name] = value(ct, lanes2);
        }
        return obj;
      }
      default: throw new Error(`KV3: неизвестный тип ${t}`);
    }
  };
  return value(readType(), lanes2);
}
