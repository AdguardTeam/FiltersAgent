import { crc32, deflateSync } from 'node:zlib';

/**
 * PNG and JPEG helpers for wire tests that need real images of a chosen size: an encoder for 8-bit
 * RGB PNGs and a reader of the pixel size an encoded PNG or JPEG declares.
 */

/**
 * The eight-byte signature every PNG file starts with.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG colour type 2: truecolour, three samples per pixel.
 */
const PNG_COLOR_TYPE_RGB = 2;

/**
 * One RGB pixel, each channel 0..255.
 */
export type RgbPixel = readonly [number, number, number];

/**
 * Pixel size an encoded image declares in its header.
 */
export interface ImageSize {
    /**
     * Width in pixels.
     */
    width: number;

    /**
     * Height in pixels.
     */
    height: number;
}

/**
 * Build one PNG chunk: length, type, data and the CRC over type and data.
 *
 * @param type - Four-letter chunk type.
 * @param data - Chunk payload.
 * @returns The encoded chunk.
 */
function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
}

/**
 * Encode an 8-bit RGB PNG whose every pixel comes from `pixel`.
 *
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @param pixel - Colour of the pixel at (x, y).
 * @returns The encoded PNG bytes.
 */
export function encodePng(
    width: number,
    height: number,
    pixel: (x: number, y: number) => RgbPixel,
): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = PNG_COLOR_TYPE_RGB;
    const rowBytes = 1 + width * 3;
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
        // Filter byte 0 (none) leads every scanline.
        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = pixel(x, y);
            const offset = y * rowBytes + 1 + x * 3;
            raw[offset] = r;
            raw[offset + 1] = g;
            raw[offset + 2] = b;
        }
    }
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Read the pixel size a PNG's IHDR or a JPEG's start-of-frame segment declares.
 *
 * @param bytes - Encoded PNG or JPEG.
 * @returns The declared width and height.
 */
export function imageSize(bytes: Buffer): ImageSize {
    if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    let offset = 2;
    while (offset < bytes.length) {
        const marker = bytes[offset + 1]!;
        const length = bytes.readUInt16BE(offset + 2);
        // SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return {
                height: bytes.readUInt16BE(offset + 5),
                width: bytes.readUInt16BE(offset + 7),
            };
        }
        offset += 2 + length;
    }
    throw new Error('No PNG header or JPEG frame found');
}
