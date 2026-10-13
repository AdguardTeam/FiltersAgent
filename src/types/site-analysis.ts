import * as v from 'valibot';

/**
 * The type of ad or tracker finding.
 */
export const FindingType = {
    /**
     * An advertisement.
     */
    Ad: 'ad',

    /**
     * A tracking script or request.
     */
    Tracker: 'tracker',

    /**
     * A cosmetic annoyance such as a popup, overlay, or newsletter prompt.
     */
    Annoyance: 'annoyance',

    /**
     * A measure that detects and reacts to an ad blocker.
     */
    AntiAdblock: 'anti-adblock',

    /**
     * An element or request that is suspicious but does not fit another category.
     */
    Suspicious: 'suspicious',
} as const;

/**
 * Every FindingType value, for schemas and exhaustive listings.
 */
export const FINDING_TYPE_VALUES = Object.values(FindingType);

/**
 * The type of ad or tracker finding (ad, tracker, annoyance, anti-adblock, or suspicious).
 */
export const FindingTypeSchema = v.picklist(FINDING_TYPE_VALUES);

/**
 * The location of the finding, expressed as a selector, URL pattern, or frame URL.
 */
export const FindingLocationSchema = v.object({
    /**
     * A CSS selector identifying the element.
     */
    selector: v.optional(v.string()),

    /**
     * A URL pattern that matched the network request.
     */
    urlPattern: v.optional(v.string()),

    /**
     * URL of the iframe or sub-frame containing the finding.
     */
    frameUrl: v.optional(v.string()),
});

/**
 * A single finding about an ad, tracker, annoyance, anti-adblock measure, or suspicious element.
 */
export const FindingSchema = v.object({
    /**
     * The category of the finding.
     */
    type: FindingTypeSchema,

    /**
     * Where the finding was observed (CSS selector, URL pattern, or frame URL).
     */
    location: FindingLocationSchema,

    /**
     * Human-readable description of the evidence.
     */
    evidence: v.string(),

    /**
     * Confidence level: 0 (uncertain) to 1 (certain).
     */
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),

    /**
     * Suggested approach to block or address the finding.
     */
    suggestedApproach: v.optional(v.string()),
});

/**
 * FindingType value.
 */
export type FindingType = (typeof FindingType)[keyof typeof FindingType];

/**
 * A single finding about an ad, tracker, annoyance, anti-adblock measure, or suspicious element.
 */
export type Finding = v.InferOutput<typeof FindingSchema>;

/**
 * A screenshot from the original issue matched against a live screenshot artifact.
 */
export interface MatchedIssueScreenshot {
    /**
     * URL of the screenshot from the issue.
     */
    issueScreenshotUrl: string;

    /**
     * Artifact ID of the live screenshot, if successfully captured.
     */
    liveArtifactId?: string;

    /**
     * Description of the match or the failure reason.
     */
    description: string;
}
