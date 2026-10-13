import { readFile } from 'node:fs/promises';
import type { ImageContent, Message } from '@earendil-works/pi-ai';

/**
 * Caller-input conversion for single-shot LLM calls: caller-authored messages to pi context parts
 * (system entries merge into the one system prompt, user entries become text or
 * text-plus-image-parts messages) and image intake (screenshot file path or in-memory bytes become
 * pi image content parts, with MIME sniffing and the vision byte cap enforced before any request
 * leaves the module). Owned by the input side of the single-shot mechanism so the call-path module
 * stays inside the repo's ~500-line module rule.
 *
 * The same limits decide, before a request is even planned, whether a stored full-page overview may
 * be offered to vision at all ({@link visionOverviewRefusal}); every caller that makes that
 * decision reads it from here so none of them can answer it differently.
 */

/**
 * MIME types the image sniffer can classify; pi's openai-completions adapter sends them as
 * `image_url` data URIs.
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
} as const;

/**
 * VisionImageMime value.
 */
export type VisionImageMime = (typeof VisionImageMime)[keyof typeof VisionImageMime];

/**
 * Largest image sent to the vision model inside one request.
 *
 * Measured against the provider gateway: a 9.5 MB request succeeds while 19 MB is refused with HTTP
 * 413, so the request ceiling is about 10 MB. base64 inflates image bytes by a third, and 6 MB
 * keeps one image plus prompt text safely below the ceiling.
 */
export const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;

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
 * sent at all.
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
 * Detect the exact image MIME from magic bytes so JPEG overviews are not mislabeled as PNG.
 *
 * @param bytes - Encoded image bytes.
 * @returns JPEG MIME for a JPEG SOI marker, PNG MIME otherwise.
 */
function sniffImageMime(bytes: Uint8Array): VisionImageMime {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return VisionImageMime.Jpeg;
    }
    return VisionImageMime.Png;
}

/**
 * Materialize one caller image input into a pi image content part, enforcing the byte cap.
 *
 * Pi's openai-completions adapter sends image parts as `image_url` data URIs and drops the OpenAI
 * `detail` hint, so no `'high'`/`'low'` hint is sent at all — an accepted loss, not a gap something
 * later fills.
 *
 * @param image - File path or in-memory bytes.
 * @returns The pi image content part.
 */
export async function toImageContent(image: SingleShotImage): Promise<ImageContent> {
    const bytes = 'path' in image ? await readFile(image.path) : image.bytes;
    if (bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
        throw new Error(
            `Vision image exceeds the ${MAX_VISION_IMAGE_BYTES}-byte cap ` +
                `(${bytes.byteLength} bytes)`,
        );
    }
    return {
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: sniffImageMime(bytes),
    };
}

/**
 * Convert caller messages into pi context parts: system texts joined in order, user messages with
 * optional image parts; each image is read and capped at that instant.
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
            ...(await Promise.all(message.images.map(toImageContent))),
        ];
        converted.push({ role: 'user', content: parts, timestamp: Date.now() });
    }
    return {
        ...(systemTexts.length > 0 ? { systemPrompt: systemTexts.join('\n\n') } : {}),
        messages: converted,
    };
}
