import { extname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import {
    LocalPublicationTrustError,
    MAX_CAPTURE_PIXELS,
    normalizeEvidencePath,
} from './local-publication-trust';

/**
 * The PNG codec this codebase trusts: decode, redact, re-encode.
 *
 * A screenshot leaving the machine must carry no metadata chunk, no timestamp, no interlacing —
 * and, where a redaction region was asked for, no pixels under it. Rebuilding the file from its own
 * decoded scanlines is what proves that: an artifact this module produced contains exactly the
 * chunks it wrote. A leaf on purpose — it knows nothing about publication layout or evidence
 * collections, only bytes in and normalized bytes out.
 */

/**
 * PNG file signature.
 */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * One rectangular region that must be pixel-redacted by the Host normalizer.
 */
export interface PixelRedactionRegion {
    /**
     * Zero-based left coordinate.
     */
    x: number;

    /**
     * Zero-based top coordinate.
     */
    y: number;

    /**
     * Positive region width.
     */
    width: number;

    /**
     * Positive region height.
     */
    height: number;
}

/**
 * Decoded and deterministically re-encoded PNG output.
 */
interface NormalizedPng {
    /**
     * Metadata-free PNG bytes.
     */
    bytes: Buffer;

    /**
     * Decoded pixel width.
     */
    width: number;

    /**
     * Decoded pixel height.
     */
    height: number;
}

declare const trustedCaptureBrand: unique symbol;

/**
 * Opaque Host-issued metadata-free PNG with a pixel-redaction proof.
 */
export interface TrustedNormalizedCapture {
    /**
     * Compile-time opaque trusted-capture marker.
     */
    readonly [trustedCaptureBrand]: true;
}

/**
 * Inputs for Host-owned trusted PNG normalization.
 */
export interface NormalizeTrustedPngCaptureOptions {
    /**
     * Evidence-collection-relative PNG path represented by the proof.
     */
    relativePath: string;

    /**
     * Exact untrusted capture bytes supplied directly by the Host capture layer.
     */
    pngBytes: Uint8Array;

    /**
     * Stable semantic image role.
     */
    role: string;

    /**
     * Opaque Host proof identity.
     */
    proofId: string;

    /**
     * Pixel regions replaced before deterministic re-encoding. Empty when the capture is of the
     * run's own clean browser on a public page and holds no reporter pixels.
     */
    regions: readonly PixelRedactionRegion[];
}

/**
 * Private normalized capture bytes and proof facts.
 */
export interface TrustedCaptureData {
    /**
     * Exact evidence-relative path.
     */
    relativePath: string;

    /**
     * Stable image role.
     */
    role: string;

    /**
     * Opaque proof identity.
     */
    proofId: string;

    /**
     * Deterministically normalized metadata-free bytes.
     */
    bytes: Buffer;

    /**
     * Decoded width.
     */
    width: number;

    /**
     * Decoded height.
     */
    height: number;
}

/**
 * Private proof data keyed only by Host-issued opaque objects.
 */
export const trustedCaptureData = new WeakMap<object, TrustedCaptureData>();

/**
 * Compute PNG CRC-32.
 *
 * @param bytes - Chunk type and data.
 * @returns Unsigned CRC-32.
 */
function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode one deterministic PNG chunk.
 *
 * @param type - Four-byte ASCII chunk type.
 * @param data - Chunk data.
 * @returns Complete encoded chunk.
 */
function encodePngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, checksum]);
}

/**
 * Paeth predictor used by PNG scanline reconstruction.
 *
 * @param left - Reconstructed byte to the left.
 * @param above - Reconstructed byte above.
 * @param upperLeft - Reconstructed byte diagonally above-left.
 * @returns Predicted byte value.
 */
function paeth(left: number, above: number, upperLeft: number): number {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
        return left;
    }
    return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

/**
 * Decode, pixel-redact and deterministically re-encode a supported PNG.
 *
 * @param pngBytes - Raw Host capture bytes.
 * @param regions - Exact pixel-redaction regions.
 * @returns Metadata-free normalized PNG and dimensions.
 */
function normalizePng(
    pngBytes: Uint8Array,
    regions: readonly PixelRedactionRegion[],
): NormalizedPng {
    const input = Buffer.from(pngBytes);
    if (
        input.byteLength < PNG_SIGNATURE.byteLength ||
        !input.subarray(0, 8).equals(PNG_SIGNATURE)
    ) {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    let offset = 8;
    let header: Buffer | null = null;
    const compressed: Buffer[] = [];
    let ended = false;
    while (offset < input.byteLength) {
        if (offset + 12 > input.byteLength) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
        const length = input.readUInt32BE(offset);
        const chunkEnd = offset + 12 + length;
        if (chunkEnd > input.byteLength) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
        const typeBytes = input.subarray(offset + 4, offset + 8);
        const type = typeBytes.toString('ascii');
        const data = input.subarray(offset + 8, offset + 8 + length);
        const expectedCrc = input.readUInt32BE(offset + 8 + length);
        if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
        if (type === 'IHDR') {
            if (header || length !== 13 || offset !== 8) {
                throw new LocalPublicationTrustError('invalid_image_proof');
            }
            header = Buffer.from(data);
        } else if (type === 'IDAT') {
            if (!header || ended) {
                throw new LocalPublicationTrustError('invalid_image_proof');
            }
            compressed.push(Buffer.from(data));
        } else if (type === 'IEND') {
            if (length !== 0 || !header || compressed.length === 0) {
                throw new LocalPublicationTrustError('invalid_image_proof');
            }
            ended = true;
            offset = chunkEnd;
            break;
        } else if ((typeBytes[0]! & 0x20) === 0) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
        offset = chunkEnd;
    }
    if (!ended || offset !== input.byteLength || !header) {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const bitDepth = header[8];
    const colorType = header[9];
    const channels =
        colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (
        width === 0 ||
        height === 0 ||
        width * height > MAX_CAPTURE_PIXELS ||
        bitDepth !== 8 ||
        channels === 0 ||
        header[10] !== 0 ||
        header[11] !== 0 ||
        header[12] !== 0
    ) {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    for (const region of regions) {
        if (
            !Number.isInteger(region.x) ||
            !Number.isInteger(region.y) ||
            !Number.isInteger(region.width) ||
            !Number.isInteger(region.height) ||
            region.x < 0 ||
            region.y < 0 ||
            region.width <= 0 ||
            region.height <= 0 ||
            region.x + region.width > width ||
            region.y + region.height > height
        ) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
    }
    const rowBytes = width * channels;
    let filtered: Buffer;
    try {
        filtered = inflateSync(Buffer.concat(compressed), {
            maxOutputLength: (rowBytes + 1) * height,
        });
    } catch {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    if (filtered.byteLength !== (rowBytes + 1) * height) {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    const pixels = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
        const inputRow = y * (rowBytes + 1);
        const outputRow = y * rowBytes;
        const filter = filtered[inputRow];
        if (filter === undefined || filter > 4) {
            throw new LocalPublicationTrustError('invalid_image_proof');
        }
        for (let x = 0; x < rowBytes; x += 1) {
            const raw = filtered[inputRow + 1 + x]!;
            const left = x >= channels ? pixels[outputRow + x - channels]! : 0;
            const above = y > 0 ? pixels[outputRow - rowBytes + x]! : 0;
            const upperLeft =
                y > 0 && x >= channels ? pixels[outputRow - rowBytes + x - channels]! : 0;
            let reconstructed = raw;
            if (filter === 1) {
                reconstructed += left;
            } else if (filter === 2) {
                reconstructed += above;
            } else if (filter === 3) {
                reconstructed += Math.floor((left + above) / 2);
            } else if (filter === 4) {
                reconstructed += paeth(left, above, upperLeft);
            }
            pixels[outputRow + x] = reconstructed & 0xff;
        }
    }
    for (const region of regions) {
        for (let y = region.y; y < region.y + region.height; y += 1) {
            for (let x = region.x; x < region.x + region.width; x += 1) {
                const pixel = (y * width + x) * channels;
                for (let channel = 0; channel < channels; channel += 1) {
                    const isAlpha =
                        (colorType === 4 && channel === 1) || (colorType === 6 && channel === 3);
                    pixels[pixel + channel] = isAlpha ? 255 : 0;
                }
            }
        }
    }
    const deterministicRows = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y += 1) {
        pixels.copy(deterministicRows, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
    }
    const normalized = Buffer.concat([
        PNG_SIGNATURE,
        encodePngChunk('IHDR', header),
        encodePngChunk('IDAT', deflateSync(deterministicRows, { level: 9 })),
        encodePngChunk('IEND', Buffer.alloc(0)),
    ]);
    return { bytes: normalized, width, height };
}

/**
 * Issue an opaque trusted capture after pixel redaction and metadata-free re-encoding.
 *
 * @param options - Host capture bytes, role, regions and proof identity.
 * @returns Opaque normalized capture capability.
 */
export function normalizeTrustedPngCapture(
    options: NormalizeTrustedPngCaptureOptions,
): TrustedNormalizedCapture {
    const relativePath = normalizeEvidencePath(options.relativePath);
    if (extname(relativePath).toLowerCase() !== '.png') {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.proofId) ||
        options.role.length === 0
    ) {
        throw new LocalPublicationTrustError('invalid_image_proof');
    }
    const normalized = normalizePng(options.pngBytes, options.regions);
    const capture = Object.freeze({}) as TrustedNormalizedCapture;
    trustedCaptureData.set(capture, {
        relativePath,
        role: options.role.slice(0, 128),
        proofId: options.proofId,
        ...normalized,
    });
    return capture;
}
