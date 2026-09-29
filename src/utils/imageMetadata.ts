/** Header-only inspection. Limits are checked before allocating a decoded bitmap. */
export interface ImageMetadata {
  format: string;
  dimensions?: [number, number] | null;
  animated?: boolean;
}

export const artworkMime = (format: string) => {
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
  if (format === 'ico') return 'image/x-icon';
  if (format === 'webm') return 'video/webm';
  return `image/${format}`;
};

export const inspectImageBlob = async (blob: Blob): Promise<ImageMetadata> => {
  const bytes = new Uint8Array(await blob.slice(0, 2 * 1024 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const text = (offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
  const invalid = () => new Error('PA_ERROR_INVALID_ARTWORK');
  if (bytes.length < 10) throw invalid();
  if (text(1, 3) === 'PNG' && bytes[0] === 137 && bytes.length >= 24 && text(12, 4) === 'IHDR') {
    let animated = false;
    let position = 8;
    // Ancillary metadata can precede acTL and can itself exceed the old 1 KiB probe.
    for (let count = 0; count < 4096 && position + 8 <= blob.size; count += 1) {
      const header = new Uint8Array(await blob.slice(position, position + 8).arrayBuffer());
      if (header.length < 8) throw invalid();
      const length = new DataView(header.buffer).getUint32(0);
      if (position + length + 12 > blob.size) throw invalid();
      const kind = String.fromCharCode(...header.subarray(4, 8));
      if (kind === 'acTL') { animated = true; break; }
      if (kind === 'IDAT' || kind === 'IEND') break;
      position += length + 12;
    }
    return { format: 'png', dimensions: [view.getUint32(16), view.getUint32(20)], animated };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    const sof = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
    while (offset + 4 <= bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 255) offset += 1;
      while (offset < bytes.length && bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 1 || marker === 216 || marker === 217 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (sof.has(marker) && length >= 7) return { format: 'jpg', dimensions: [view.getUint16(offset + 5), view.getUint16(offset + 3)], animated: false };
      offset += length;
    }
    throw invalid();
  }
  if (text(0, 3) === 'GIF') return { format: 'gif', dimensions: [view.getUint16(6, true), view.getUint16(8, true)], animated: true };
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && bytes.length >= 30) {
    const kind = text(12, 4);
    if (kind === 'VP8X') return { format: 'webp', animated: Boolean(bytes[20] & 2), dimensions: [1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536, 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536] };
    if (kind === 'VP8 ') return { format: 'webp', animated: false, dimensions: [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff] };
    if (kind === 'VP8L') return { format: 'webp', animated: false, dimensions: [1 + ((bytes[22] & 63) << 8) + bytes[21], 1 + ((bytes[24] & 15) << 10) + (bytes[23] << 2) + ((bytes[22] & 192) >> 6)] };
    throw invalid();
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return { format: 'ico', dimensions: [bytes[6] || 256, bytes[7] || 256], animated: false };
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return { format: 'webm', animated: true, dimensions: null };
  throw new Error('PA_ERROR_ARTWORK_FORMAT_UNKNOWN');
};
