import { readFile } from 'node:fs/promises';
import type { ImageContent, Message } from '@earendil-works/pi-ai';
import { resizeImage } from '@earendil-works/pi-coding-agent';

/**
 * Caller-input conversion for single-shot LLM calls: caller-authored messages to pi context parts
 * (system entries merge into the one system prompt, user entries become text or
 * text-plus-image-parts messages) and image intake (screenshot file path or in-memory bytes become
 * pi image content parts, with MIME sniffing, the vision byte cap and the provider's per-image
 * limits enforced before any request leaves the module). Every image any vision request carries
 * passes through here, so this is the one place that fits images to {@link VISION_IMAGE_LIMITS}.
 * Owned by the input side of the single-shot mechanism so the call-path module stays inside the
 * repo's ~500-line module rule.
 *
 * The same limits decide, before a request is even planned, whether a stored full-page overview may
 * be offered to vision at all ({@link visionOverviewRefusal}); every caller that makes that
 * decision reads it from here so none of them can answer it differently.
 */

/**
 * MIME types the image sniffer can classify. Pi sends base64 image content as OpenAI image_url data
 * URIs or Anthropic image source blocks.
 */
export const VisionImageMime = {
    /**
     * Portable Network Graphics.
     */
    Png: 'image/png',

    /**
     * Joint Photographic Experts Group.
     */
    Jpeg: 'image/jpeg',

    /**
     * Graphics Interchange Format; a reporter screenshot may arrive as one.
     */
    Gif: 'image/gif',

    /**
     * WebP; a reporter screenshot may arrive as one.
     */
    Webp: 'image/webp',
} as const;

/**
 * VisionImageMime value.
 */
export type VisionImageMime = (typeof VisionImageMime)[keyof typeof VisionImageMime];

/**
 * Largest image a caller may hand to the vision model, in raw bytes before base64 encoding.
 *
 * One shared cap for both APIs that keeps a request of a few images below the gateway's roughly 10
 * MB request ceiling. What the provider itself accepts per image is {@link VISION_IMAGE_LIMITS},
 * which every image is fitted to after this cap admits it.
 */
export const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Per-image limits a vision provider enforces, from Anthropic's vision guide
 * (https://platform.claude.com/docs/en/build-with-claude/vision#request-limits), the strictest of
 * the supported providers; OpenAI-family models downscale oversized images instead of refusing
 * them. A request breaking one is refused with HTTP 400 for the image itself, so every image is
 * fitted to them before it leaves this module.
 */
export const VISION_IMAGE_LIMITS = {
    /**
     * Longest side of one image: "The maximum dimensions per image are 8000x8000 px."
     */
    maxSidePx: 8_000,

    /**
     * Image count above which the stricter side limit applies to every image of the request.
     */
    manyImagesThreshold: 20,

    /**
     * Longest side of every image in a request carrying more than `manyImagesThreshold` images.
     */
    manyImagesMaxSidePx: 2_000,

    /**
     * Base64-encoded size of one image: 5 MB on Amazon Bedrock and Google Cloud, 10 MB on the
     * Claude API itself. An OpenAI-compatible gateway does not say which platform serves the model,
     * so the lower one holds on both APIs.
     */
    maxEncodedBytes: 5 * 1024 * 1024,
} as const;

/**
 * Tallest full-page overview, as a multiple of its width, that a vision model can still read.
 *
 * A provider fits a multimodal image inside a bounded square of about 2048 px on its long side, so
 * a page eight times taller than wide arrives about 256 px wide — the narrowest width at which
 * blocks of a page still read as blocks rather than as a stripe. Past that the model cannot see the
 * page and answers from the prompt instead of the pixels: a 375x10334 px mobile overview (aspect
 * 27.5:1, 1.3 MB, well inside the byte cap) arrives ~74 px wide, and the model can report
 * "remaining blank reserved ad-slot bands" quoted straight out of the symptom text while the
 * viewport screenshot and the original-resolution tiles of that same state show every band gone.
 * Such a fabricated inventory rejects a correct candidate, so an overview past this ratio is not
 * sent at all: the review answers only for the tile window, and its map is a screenshot of that
 * window cut at this ratio instead of the whole-page stripe.
 */
export const MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO = 8;

/**
 * Why one full-page overview may not be sent to the vision model as a single image.
 */
export const VisionOverviewRefusal = {
    /**
     * Its encoded bytes exceed what one multimodal request may carry.
     */
    Oversized: 'oversized',

    /**
     * It is so much taller than it is wide that the provider's downscaling leaves it unreadable.
     */
    Illegible: 'illegible',
} as const;

/**
 * VisionOverviewRefusal value.
 */
export type VisionOverviewRefusal =
    (typeof VisionOverviewRefusal)[keyof typeof VisionOverviewRefusal];

/**
 * What a producer recorded about one stored full-page overview.
 */
export interface VisionOverviewGeometry {
    /**
     * Encoded size of the stored overview in bytes; absent when no producer recorded it.
     */
    bytes?: number;

    /**
     * Document width in CSS pixels the overview spans; absent when the capture recorded none.
     */
    documentWidth?: number;

    /**
     * Document height in CSS pixels the overview spans; absent when the capture recorded none.
     */
    documentHeight?: number;
}

/**
 * Decide whether one full-page overview may be sent to the vision model as a single image.
 *
 * The single answer every deciding call site reads — the candidate review's overview plan, the
 * pre-candidate capture inventory, and the runtime's terminal vision requirement — so the run can
 * never demand inspection of an artifact the inventory withheld, or send one the plan refused.
 *
 * Geometry a producer did not record refuses nothing: an overview of unknown size or extent is
 * offered as is.
 *
 * @param overview - What the runner knows about the stored overview.
 * @returns The refusal keeping this overview out of vision, or null when it may be sent.
 */
export function visionOverviewRefusal(
    overview: VisionOverviewGeometry,
): VisionOverviewRefusal | null {
    if (overview.bytes !== undefined && overview.bytes > MAX_VISION_IMAGE_BYTES) {
        return VisionOverviewRefusal.Oversized;
    }
    const { documentWidth, documentHeight } = overview;
    if (
        documentWidth !== undefined &&
        documentHeight !== undefined &&
        documentWidth > 0 &&
        documentHeight > MAX_LEGIBLE_OVERVIEW_ASPECT_RATIO * documentWidth
    ) {
        return VisionOverviewRefusal.Illegible;
    }
    return null;
}

/**
 * One image input for a single-shot message.
 */
export type SingleShotImage =
    | {
          /**
           * Screenshot file read at send time.
           */
          path: string;
      }
    | {
          /**
           * Screenshot bytes already in memory.
           */
          bytes: Uint8Array;
      };

/**
 * Roles a caller may author on a single-shot message. Assistant turns are never authored by callers
 * — the repair loop owns them internally.
 */
export const SingleShotMessageRole = {
    /**
     * System-role entry; system entries merge into the one system prompt.
     */
    System: 'system',

    /**
     * User-role entry carrying text and optional images.
     */
    User: 'user',
} as const;

/**
 * SingleShotMessageRole value.
 */
export type SingleShotMessageRole =
    (typeof SingleShotMessageRole)[keyof typeof SingleShotMessageRole];

/**
 * One caller-authored single-shot message.
 */
export type SingleShotMessage =
    | {
          /**
           * System-role entry; system entries merge into the one system prompt.
           */
          role: typeof SingleShotMessageRole.System;

          /**
           * System text merged after the schema contract (structured path) or forming the system
           * prompt (text path).
           */
          text: string;
      }
    | {
          /**
           * User-role entry carrying text and optional images.
           */
          role: typeof SingleShotMessageRole.User;

          /**
           * Plain user text.
           */
          text: string;
      }
    | {
          /**
           * User-role entry carrying text and optional images.
           */
          role: typeof SingleShotMessageRole.User;

          /**
           * Plain user text; omitted when only images are sent.
           */
          text?: string;

          /**
           * Image parts attached to this user turn.
           */
          images: SingleShotImage[];
      };

/**
 * Signature a GIF file starts with, shared by GIF87a and GIF89a.
 */
const GIF_SIGNATURE = Buffer.from('GIF8', 'ascii');

/**
 * RIFF container tag a WebP file starts with.
 */
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');

/**
 * Form type at byte 8 of a RIFF container that holds a WebP image.
 */
const WEBP_FORM_TYPE = Buffer.from('WEBP', 'ascii');

/**
 * Byte offset of the RIFF form type, after the tag and the four-byte chunk size.
 */
const RIFF_FORM_TYPE_OFFSET = 8;

/**
 * Detect the exact image MIME from magic bytes. An image inside the provider limits is sent as it
 * is, with this type declared beside it, and a provider may refuse an image whose declared type
 * does not match its bytes.
 *
 * @param bytes - Encoded image bytes.
 * @returns JPEG, GIF or WebP MIME for their signatures, PNG MIME otherwise.
 */
export function sniffImageMime(bytes: Uint8Array): VisionImageMime {
    const head = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return VisionImageMime.Jpeg;
    }
    if (head.subarray(0, GIF_SIGNATURE.length).equals(GIF_SIGNATURE)) {
        return VisionImageMime.Gif;
    }
    if (
        head.subarray(0, RIFF_SIGNATURE.length).equals(RIFF_SIGNATURE) &&
        head
            .subarray(RIFF_FORM_TYPE_OFFSET, RIFF_FORM_TYPE_OFFSET + WEBP_FORM_TYPE.length)
            .equals(WEBP_FORM_TYPE)
    ) {
        return VisionImageMime.Webp;
    }
    return VisionImageMime.Png;
}

/**
 * Longest image side a request carrying `imageCount` images may send.
 *
 * @param imageCount - Images in the whole request.
 * @returns The side limit every image of that request must fit.
 */
function maxSidePx(imageCount: number): number {
    return imageCount > VISION_IMAGE_LIMITS.manyImagesThreshold
        ? VISION_IMAGE_LIMITS.manyImagesMaxSidePx
        : VISION_IMAGE_LIMITS.maxSidePx;
}

/**
 * Materialize one caller image input into a pi image content part that fits the provider limits.
 *
 * An image inside the limits is sent byte for byte. A larger one is scaled down whole, aspect kept,
 * and re-encoded as whichever of PNG or JPEG fits; cropping or splitting would change what the
 * caller asked about. Past the side limit alone, scaling loses nothing the model could read: the
 * provider would shrink the image at least as far before the model sees it. Past the encoded-size
 * limit it does lose detail the provider would have kept: the image is re-encoded as JPEG at
 * falling quality, then shrunk further, until it fits.
 *
 * Pi maps base64 images to image_url data URIs on OpenAI or image source blocks on Anthropic.
 * Neither path here sets a provider-specific detail hint.
 *
 * @param image - File path or in-memory bytes.
 * @param sideLimitPx - Longest side the image may keep in this request.
 * @returns The pi image content part.
 */
async function toImageContent(image: SingleShotImage, sideLimitPx: number): Promise<ImageContent> {
    const bytes = 'path' in image ? await readFile(image.path) : image.bytes;
    if (bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
        throw new Error(
            `Vision image exceeds the ${MAX_VISION_IMAGE_BYTES}-byte cap ` +
                `(${bytes.byteLength} bytes)`,
        );
    }
    const fitted = await resizeImage(bytes, sniffImageMime(bytes), {
        maxWidth: sideLimitPx,
        maxHeight: sideLimitPx,
        maxBytes: VISION_IMAGE_LIMITS.maxEncodedBytes,
    });
    if (fitted === null) {
        throw new Error(
            `Vision image of ${bytes.byteLength} bytes could not be decoded or fitted to ` +
                `${sideLimitPx} px per side and ${VISION_IMAGE_LIMITS.maxEncodedBytes} encoded bytes`,
        );
    }
    return { type: 'image', data: fitted.data, mimeType: fitted.mimeType };
}

/**
 * Downscale an encoded image to fit a side limit and an encoded-size limit, aspect kept.
 *
 * Unlike a request image, the source may be past the per-image byte cap: the result is a derivative
 * at a caller-chosen small size, never the original.
 *
 * @param bytes - Encoded image bytes.
 * @param sideLimitPx - Longest side the result may have.
 * @param maxEncodedBytes - Largest base64-encoded size the result may have.
 * @returns The fitted image bytes, or null when the image cannot be decoded or fitted.
 */
export async function fitImage(
    bytes: Uint8Array,
    sideLimitPx: number,
    maxEncodedBytes: number,
): Promise<Buffer | null> {
    const fitted = await resizeImage(bytes, sniffImageMime(bytes), {
        maxWidth: sideLimitPx,
        maxHeight: sideLimitPx,
        maxBytes: maxEncodedBytes,
    });
    return fitted === null ? null : Buffer.from(fitted.data, 'base64');
}

/**
 * Convert caller messages into pi context parts: system texts joined in order, user messages with
 * optional image parts; each image is read, capped and fitted at that instant, against the side
 * limit the request's total image count selects.
 *
 * @param messages - Caller-authored single-shot messages.
 * @returns The joined system prompt (when any) and the pi message list.
 */
export async function toPiMessages(messages: SingleShotMessage[]): Promise<{
    /**
     * Joined system prompt present when any system text was authored.
     */
    systemPrompt?: string;

    /**
     * Converted pi message list.
     */
    messages: Message[];
}> {
    const systemTexts: string[] = [];
    const converted: Message[] = [];
    const sideLimitPx = maxSidePx(
        messages.reduce(
            (count, message) => count + ('images' in message ? message.images.length : 0),
            0,
        ),
    );
    for (const message of messages) {
        if (message.role === SingleShotMessageRole.System) {
            systemTexts.push(message.text);
            continue;
        }
        if (!('images' in message)) {
            converted.push({ role: 'user', content: message.text, timestamp: Date.now() });
            continue;
        }
        const parts = [
            ...(message.text !== undefined ? [{ type: 'text' as const, text: message.text }] : []),
            ...(await Promise.all(
                message.images.map((image) => toImageContent(image, sideLimitPx)),
            )),
        ];
        converted.push({ role: 'user', content: parts, timestamp: Date.now() });
    }
    return {
        ...(systemTexts.length > 0 ? { systemPrompt: systemTexts.join('\n\n') } : {}),
        messages: converted,
    };
}
