/** PNG / JPEG 버퍼에서 픽셀 크기만 읽습니다(WebP 미지원). */
export function getPngOrJpegDimensionsFromBuffer(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0 && width < 100_000 && height < 100_000) {
      return { width, height };
    }
    return null;
  }

  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }

  let o = 2;
  while (o < buf.length - 1) {
    if (buf[o] !== 0xff) {
      o += 1;
      continue;
    }
    const marker = buf[o + 1];
    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x00) {
      o += 2;
      continue;
    }
    if (o + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(o + 2);
    if (segLen < 2 || o + 2 + segLen > buf.length) break;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && o + 9 < buf.length) {
      const height = buf.readUInt16BE(o + 5);
      const width = buf.readUInt16BE(o + 7);
      if (width > 0 && height > 0 && width < 100_000 && height < 100_000) {
        return { width, height };
      }
      return null;
    }
    o += 2 + segLen;
  }
  return null;
}
