/**
 * Fixed, no-argument main-frame light-DOM scan executed in a browser isolated world.
 *
 * The expression returns sanitized, bounded IDs and classes only as untrusted page identifiers. It
 * never returns raw text, HTML, URLs, or other attribute values. It inspects signal matches across
 * every light-DOM tag, but materializes at most 256 candidate records before prioritizing at most
 * 32 visible empty, high-area slots for the typed result.
 */
export const AD_SLOT_INSPECTION_EXPRESSION = String.raw`
(function () {
    'use strict';

    const MAX_INSPECTED_CANDIDATES = 256;
    const MAX_RETURNED_SLOTS = 32;
    const MAX_ANCESTORS = 32;
    const MAX_DESCENDANTS = 128;
    const MAX_CLASSES = 16;
    const MAX_TOKEN_LENGTH = 128;
    const MAX_MEANINGFUL_TEXT_LENGTH = 16384;
    const AD_TOKENS = new Set([
        'ad',
        'ads',
        'adslot',
        'advert',
        'advertisement',
        'banner',
        'dfp',
        'doubleclick',
        'gam',
        'googleads',
        'googlesyndication',
        'gpt',
        'sponsor',
        'sponsored',
    ]);
    const CREATIVE_TAG_SIGNALS = {
        IFRAME: 'iframe',
        IMG: 'image',
        PICTURE: 'image',
        VIDEO: 'video',
        CANVAS: 'canvas',
        OBJECT: 'object',
        EMBED: 'object',
        SVG: 'image',
    };
    const IGNORED_TEXT_TAGS = new Set([
        'SCRIPT',
        'STYLE',
        'TEMPLATE',
        'NOSCRIPT',
        'LINK',
        'META',
    ]);

    const boundedString = function (value, maximumLength) {
        return String(value == null ? '' : value).slice(0, maximumLength);
    };
    const boundedIdentifier = function (value, maximumLength) {
        return String(value == null ? '' : value)
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
            .slice(0, maximumLength);
    };
    const finiteNumber = function (value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    };
    const tokenMatches = function (value) {
        const bounded = boundedString(value, 4096).toLowerCase();
        const tokens = bounded.split(/[^a-z0-9]+/g);
        return tokens.some(function (token) {
            return AD_TOKENS.has(token);
        });
    };
    const pushUnique = function (items, value) {
        if (!items.includes(value)) items.push(value);
    };
    const readClasses = function (element) {
        const classes = [];
        const classList = element.classList;
        const count = Math.min(classList ? classList.length : 0, MAX_CLASSES);
        for (let index = 0; index < count; index += 1) {
            const token = boundedIdentifier(classList.item ? classList.item(index) : classList[index], MAX_TOKEN_LENGTH);
            if (token.length > 0) classes.push(token);
        }
        return classes;
    };
    const readStyle = function (element) {
        let style;
        try {
            style = getComputedStyle(element);
        } catch {
            style = {};
        }
        return {
            display: boundedString(style.display, MAX_TOKEN_LENGTH),
            visibility: boundedString(style.visibility, MAX_TOKEN_LENGTH),
            opacity: boundedString(style.opacity, MAX_TOKEN_LENGTH),
            position: boundedString(style.position, MAX_TOKEN_LENGTH),
            height: boundedString(style.height, MAX_TOKEN_LENGTH),
            minHeight: boundedString(style.minHeight, MAX_TOKEN_LENGTH),
            maxHeight: boundedString(style.maxHeight, MAX_TOKEN_LENGTH),
        };
    };
    const readRect = function (element) {
        let rect;
        try {
            rect = element.getBoundingClientRect();
        } catch {
            rect = {};
        }
        return {
            x: finiteNumber(rect.x),
            y: finiteNumber(rect.y),
            top: finiteNumber(rect.top),
            right: finiteNumber(rect.right),
            bottom: finiteNumber(rect.bottom),
            left: finiteNumber(rect.left),
            width: Math.max(0, finiteNumber(rect.width)),
            height: Math.max(0, finiteNumber(rect.height)),
        };
    };
    const readHiddenAncestors = function (element) {
        let current = element;
        let depth = 0;
        let hidden = false;
        let displayNone = false;
        while (current && depth < 256) {
            let style;
            try {
                style = getComputedStyle(current);
            } catch {
                style = {};
            }
            const display = String(style.display || '').toLowerCase();
            const visibility = String(style.visibility || '').toLowerCase();
            const opacity = Number.parseFloat(String(style.opacity || '1'));
            if (display === 'none') displayNone = true;
            if (
                display === 'none' ||
                visibility === 'hidden' ||
                visibility === 'collapse' ||
                (Number.isFinite(opacity) && opacity <= 0)
            ) {
                hidden = true;
            }
            current = current.parentElement;
            depth += 1;
        }
        if (current) {
            hidden = true;
            displayNone = true;
        }
        return { hidden, displayNone };
    };
    const snapshot = function (element) {
        const rect = readRect(element);
        const style = readStyle(element);
        const hiddenAncestors = readHiddenAncestors(element);
        const id = boundedIdentifier(element.id, MAX_TOKEN_LENGTH);
        const viewportWidth = Math.max(
            0,
            finiteNumber(window.innerWidth || document.documentElement.clientWidth),
        );
        const viewportHeight = Math.max(
            0,
            finiteNumber(window.innerHeight || document.documentElement.clientHeight),
        );
        const hasArea = rect.width > 0 && rect.height > 0;
        const intersectsViewport =
            hasArea &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < viewportWidth &&
            rect.top < viewportHeight;
        const occupiesLayoutSpace = hasArea && !hiddenAncestors.displayNone;
        let state = 'visible';
        if (hiddenAncestors.hidden) state = 'hidden';
        else if (!hasArea) state = 'zero_area';
        else if (!intersectsViewport) state = 'offscreen';
        return {
            tag: boundedString(element.tagName, 32).toLowerCase(),
            id: id.length > 0 ? id : null,
            classes: readClasses(element),
            viewportRect: rect,
            computedStyle: style,
            visibility: {
                state,
                occupiesLayoutSpace,
                intersectsViewport,
                ancestorHidden: hiddenAncestors.hidden,
            },
        };
    };
    const matchSignals = function (element) {
        const signals = [];
        if (tokenMatches(element.id)) pushUnique(signals, 'id-ad-token');
        const classList = element.classList;
        const classCount = classList ? Math.min(classList.length, 256) : 0;
        for (let index = 0; index < classCount; index += 1) {
            const className = classList.item ? classList.item(index) : classList[index];
            if (tokenMatches(className)) {
                pushUnique(signals, 'class-ad-token');
                break;
            }
        }
        const adAttributeNames = [
            'data-ad',
            'data-ads',
            'data-ad-slot',
            'data-ad-unit',
            'data-adunit',
            'data-google-query-id',
        ];
        if (adAttributeNames.some(function (name) { return element.hasAttribute(name); })) {
            pushUnique(signals, 'ad-attribute-name');
        }
        const role = boundedString(element.getAttribute('role'), 128).toLowerCase();
        if (role === 'advertisement' || role === 'ad') {
            pushUnique(signals, 'ad-role');
        }
        const tag = String(element.tagName || '').toUpperCase();
        if (tag === 'AD-SLOT' || tag === 'AMP-AD') pushUnique(signals, 'ad-tag');
        if (tag === 'IFRAME') {
            const frameSource = boundedString(element.getAttribute('src'), 2048);
            if (tokenMatches(frameSource)) pushUnique(signals, 'ad-frame-url');
        }
        return signals;
    };
    const inspectContent = function (element) {
        const descendants = element.querySelectorAll('*');
        const descendantCount = Math.min(descendants.length, Number.MAX_SAFE_INTEGER);
        let contentScanTruncated = descendants.length > MAX_DESCENDANTS;
        let meaningfulTextLength = 0;
        const creativeSignals = [];
        const inspectedNodes = [element];
        const inspectedDescendantCount = Math.min(descendants.length, MAX_DESCENDANTS);
        for (let index = 0; index < inspectedDescendantCount; index += 1) {
            inspectedNodes.push(descendants[index]);
        }
        for (const node of inspectedNodes) {
            const tag = String(node.tagName || '').toUpperCase();
            const creativeTag = CREATIVE_TAG_SIGNALS[tag];
            const renderedRect = readRect(node);
            const renderedPositiveArea =
                renderedRect.width > 0 &&
                renderedRect.height > 0 &&
                !readHiddenAncestors(node).hidden;
            if (creativeTag && renderedPositiveArea) {
                pushUnique(
                    creativeSignals,
                    (node === element ? 'self-' : 'descendant-') + creativeTag,
                );
            }
            let style;
            try {
                style = getComputedStyle(node);
            } catch {
                style = {};
            }
            if (
                renderedPositiveArea &&
                style.backgroundImage &&
                style.backgroundImage !== 'none'
            ) {
                pushUnique(creativeSignals, 'css-background-image');
            }
            if (IGNORED_TEXT_TAGS.has(tag)) continue;
            const childNodes = node.childNodes || [];
            for (let index = 0; index < childNodes.length; index += 1) {
                const child = childNodes[index];
                if (child.nodeType !== Node.TEXT_NODE) continue;
                const remaining = MAX_MEANINGFUL_TEXT_LENGTH - meaningfulTextLength;
                if (remaining <= 0) {
                    contentScanTruncated = true;
                    break;
                }
                const raw = String(child.nodeValue || '');
                const bounded = raw.slice(0, remaining + 1);
                const normalized = bounded.trim().replace(/\s+/g, ' ');
                if (normalized.length > remaining || raw.length > remaining + 1) {
                    meaningfulTextLength = MAX_MEANINGFUL_TEXT_LENGTH;
                    contentScanTruncated = true;
                    break;
                }
                meaningfulTextLength += normalized.length;
            }
        }
        const contentState = contentScanTruncated
            ? 'unknown'
            : creativeSignals.length > 0
              ? 'creative'
              : meaningfulTextLength === 0
                ? 'empty'
                : 'unknown';
        return {
            contentState,
            creativeSignals,
            meaningfulTextLength,
            descendantCount,
            contentScanTruncated,
        };
    };
    const inspectCandidate = function (candidate) {
        const ancestors = [];
        let ancestor = candidate.element.parentElement;
        while (ancestor && ancestors.length < MAX_ANCESTORS) {
            ancestors.push(snapshot(ancestor));
            ancestor = ancestor.parentElement;
        }
        return {
            element: snapshot(candidate.element),
            ancestors,
            ancestorChainTruncated: Boolean(ancestor),
            matchedSignals: candidate.signals,
            ...inspectContent(candidate.element),
            documentOrder: candidate.documentOrder,
        };
    };
    const allElements = document.getElementsByTagName('*');
    const inspectedCandidates = [];
    let candidateCount = 0;
    for (let index = 0; index < allElements.length; index += 1) {
        const element = allElements[index];
        const signals = matchSignals(element);
        if (signals.length === 0) continue;
        candidateCount += 1;
        if (inspectedCandidates.length < MAX_INSPECTED_CANDIDATES) {
            inspectedCandidates.push({ element, signals, documentOrder: index });
        }
    }
    const records = inspectedCandidates.map(inspectCandidate);
    const visibilityRank = { visible: 0, offscreen: 1, zero_area: 2, hidden: 3 };
    const contentRank = { empty: 0, unknown: 1, creative: 2 };
    records.sort(function (left, right) {
        const visibilityDifference =
            visibilityRank[left.element.visibility.state] -
            visibilityRank[right.element.visibility.state];
        if (visibilityDifference !== 0) return visibilityDifference;
        const contentDifference = contentRank[left.contentState] - contentRank[right.contentState];
        if (contentDifference !== 0) return contentDifference;
        const leftArea = left.element.viewportRect.width * left.element.viewportRect.height;
        const rightArea = right.element.viewportRect.width * right.element.viewportRect.height;
        if (leftArea !== rightArea) return rightArea - leftArea;
        return left.documentOrder - right.documentOrder;
    });
    const slots = records.slice(0, MAX_RETURNED_SLOTS).map(function (record) {
        const output = { ...record };
        delete output.documentOrder;
        return output;
    });
    return {
        scope: 'main_frame_light_dom',
        candidateCount,
        returnedCount: slots.length,
        truncated: candidateCount > slots.length,
        slots,
    };
})()
`;
