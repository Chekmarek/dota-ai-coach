export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export function decodePng(buf: Uint8Array): DecodedPng;
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer;
