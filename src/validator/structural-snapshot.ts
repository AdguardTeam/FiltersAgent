import * as v from 'valibot';
import {
    AdElementPresence,
    StructuralSnapshotSchema,
    type StructuralSnapshot,
} from '../types/validation';
import type { TrustedPageEvaluator } from '../browser/trusted-page-evaluator';

/**
 * JavaScript snippet that measures selector scope and top-of-page semantic landmarks.
 *
 * The probe intentionally uses only DOM geometry and computed styles. It does not depend on the
 * reported site, candidate text, screenshot interpretation, or any benchmark reference.
 */
const STRUCTURAL_SNAPSHOT_PROBE = `
(function (targetSelector) {
    try {
        var emptyGeometry = function () {
            return {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
                elementKeys: [],
                occlusionEvidence: [],
            };
        };
        var rectArea = function (rect) {
            return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
        };
        var targetElements = targetSelector
            ? Array.prototype.slice.call(document.querySelectorAll(targetSelector))
            : [];
        var elementKey = function (element) {
            if (element.id) return 'id:' + element.id;
            var segments = [];
            var current = element;
            while (current && current.nodeType === 1 && segments.length < 12) {
                var parent = current.parentElement;
                var siblings = parent && parent.children
                    ? Array.prototype.slice.call(parent.children)
                    : [current];
                segments.unshift(
                    String(current.tagName || 'element').toLowerCase() +
                        ':' +
                        Math.max(0, siblings.indexOf(current)),
                );
                current = parent;
            }
            return 'path:' + segments.join('/');
        };
        var belongsToTarget = function (element) {
            return targetElements.some(function (target) {
                return target === element || target.contains(element);
            });
        };
        var colorHasVisibleAlpha = function (color) {
            if (!color) return false;
            var normalized = String(color).trim().toLowerCase();
            if (!normalized || normalized === 'transparent') return false;
            var open = normalized.indexOf('(');
            var close = normalized.lastIndexOf(')');
            if (open < 0 || close <= open) return true;
            var body = normalized.slice(open + 1, close);
            if (body.indexOf('/') >= 0) {
                var slashAlpha = Number(body.slice(body.lastIndexOf('/') + 1).trim());
                return !Number.isFinite(slashAlpha) || slashAlpha > 0.02;
            }
            var components = body.split(',').map(function (part) { return part.trim(); });
            if (components.length < 4) return true;
            var alpha = Number(components[components.length - 1]);
            return !Number.isFinite(alpha) || alpha > 0.02;
        };
        var styleHasMaterialSurface = function (style) {
            return Boolean(
                colorHasVisibleAlpha(style.backgroundColor) ||
                (style.backgroundImage && style.backgroundImage !== 'none') ||
                (style.maskImage && style.maskImage !== 'none') ||
                (style.backdropFilter && style.backdropFilter !== 'none'),
            );
        };
        var textPaintsPoint = function (element, x, y) {
            if (
                typeof document.createTreeWalker !== 'function' ||
                typeof document.createRange !== 'function'
            ) {
                return false;
            }
            var walker = document.createTreeWalker(element, 4);
            var node = walker.nextNode();
            var inspected = 0;
            while (node && inspected < 64) {
                if (String(node.nodeValue || '').trim()) {
                    var range = document.createRange();
                    range.selectNodeContents(node);
                    var rects = Array.prototype.slice.call(range.getClientRects());
                    if (rects.some(function (rect) {
                        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                    })) {
                        return true;
                    }
                }
                inspected += 1;
                node = walker.nextNode();
            }
            return false;
        };
        var materiallyPaintsPoint = function (element, x, y) {
            var replacedTags = ['CANVAS', 'IFRAME', 'IMG', 'OBJECT', 'SVG', 'VIDEO'];
            if (replacedTags.indexOf(String(element.tagName || '').toUpperCase()) >= 0) {
                return true;
            }
            if (styleHasMaterialSurface(window.getComputedStyle(element))) return true;
            if (textPaintsPoint(element, x, y)) return true;
            return ['::before', '::after'].some(function (pseudo) {
                var style = window.getComputedStyle(element, pseudo);
                var content = String(style.content || '').trim();
                return content !== '' && content !== 'none' && content !== 'normal' &&
                    styleHasMaterialSurface(style);
            });
        };
        var inspectGeometry = function (element) {
            var rawRect = element.getBoundingClientRect();
            var visibleRect = {
                left: rawRect.left,
                right: rawRect.right,
                top: rawRect.top,
                bottom: rawRect.bottom,
            };
            var rawArea = Math.max(0, rawRect.width) * Math.max(0, rawRect.height);
            var ancestorHidden = false;
            var ancestor = element;
            while (ancestor && ancestor.nodeType === 1) {
                var style = window.getComputedStyle(ancestor);
                if (
                    ancestor.hidden ||
                    ancestor.getAttribute('aria-hidden') === 'true' ||
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.visibility === 'collapse' ||
                    style.contentVisibility === 'hidden' ||
                    Number(style.opacity) <= 0.01
                ) {
                    ancestorHidden = true;
                    break;
                }
                if (ancestor !== element) {
                    var ancestorRect = ancestor.getBoundingClientRect();
                    if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
                        visibleRect.left = Math.max(visibleRect.left, ancestorRect.left);
                        visibleRect.right = Math.min(visibleRect.right, ancestorRect.right);
                    }
                    if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
                        visibleRect.top = Math.max(visibleRect.top, ancestorRect.top);
                        visibleRect.bottom = Math.min(visibleRect.bottom, ancestorRect.bottom);
                    }
                }
                ancestor = ancestor.parentElement;
            }
            var visibleArea = ancestorHidden ? 0 : rectArea(visibleRect);
            var visible = rawArea > 0 && visibleArea > 0;
            var clipped = ancestorHidden || (rawArea > 0 && visibleArea < rawArea * 0.98);
            var occluded = false;
            var occlusionEvidence = null;
            var viewportRect = {
                left: Math.max(0, visibleRect.left),
                right: Math.min(window.innerWidth, visibleRect.right),
                top: Math.max(0, visibleRect.top),
                bottom: Math.min(window.innerHeight, visibleRect.bottom),
            };
            if (visible && rectArea(viewportRect) > 0 && !belongsToTarget(element)) {
                var sampleFractions = [
                    [0.5, 0.5],
                    [0.2, 0.2],
                    [0.8, 0.2],
                    [0.2, 0.8],
                    [0.8, 0.8],
                ];
                var blockerKeys = [];
                var occludedSampleCount = sampleFractions.reduce(function (count, fractions) {
                    var sampleX = viewportRect.left +
                        (viewportRect.right - viewportRect.left) * fractions[0];
                    var sampleY = viewportRect.top +
                        (viewportRect.bottom - viewportRect.top) * fractions[1];
                    var topElement = document.elementFromPoint(sampleX, sampleY);
                    var sampleOccluded = Boolean(
                        topElement &&
                            topElement !== element &&
                            !element.contains(topElement) &&
                            !topElement.contains(element) &&
                            materiallyPaintsPoint(topElement, sampleX, sampleY),
                    );
                    if (sampleOccluded) blockerKeys.push(elementKey(topElement));
                    return count + (sampleOccluded ? 1 : 0);
                }, 0);
                var requiredOccludedSamples = Math.floor(sampleFractions.length / 2) + 1;
                occluded = occludedSampleCount >= requiredOccludedSamples;
                if (occluded) {
                    occlusionEvidence = {
                        targetKey: elementKey(element),
                        blockerKeys: Array.from(new Set(blockerKeys)),
                        occludedSampleCount: occludedSampleCount,
                        sampleCount: sampleFractions.length,
                    };
                }
            }
            return {
                visible: visible,
                visibleArea: visibleArea,
                clipped: clipped,
                occluded: occluded,
                occlusionEvidence: occlusionEvidence,
                rawWidth: Math.max(0, rawRect.width),
                rawHeight: Math.max(0, rawRect.height),
                rawArea: rawArea,
            };
        };
        var summarizeGeometry = function (elements) {
            return elements.reduce(function (summary, element) {
                var geometry = inspectGeometry(element);
                summary.totalCount += 1;
                summary.elementKeys.push(elementKey(element));
                if (geometry.visible) {
                    summary.visibleCount += 1;
                    summary.visibleArea += geometry.visibleArea;
                }
                if (geometry.clipped) summary.clippedCount += 1;
                if (geometry.occluded) {
                    summary.occludedCount += 1;
                    summary.occlusionEvidence.push(geometry.occlusionEvidence);
                }
                return summary;
            }, emptyGeometry());
        };
        var isVisible = function (element) {
            var style = window.getComputedStyle(element);
            var rect = element.getBoundingClientRect();
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity) > 0.01 &&
                rect.width > 0 &&
                rect.height > 0
            );
        };
        var allElements = Array.prototype.slice.call(document.querySelectorAll('body *'));
        var topOverlays = allElements.filter(function (element) {
            if (!isVisible(element)) return false;
            var style = window.getComputedStyle(element);
            if (style.position !== 'fixed' && style.position !== 'sticky') return false;
            var rect = element.getBoundingClientRect();
            return (
                rect.top <= 1 &&
                rect.bottom > 0 &&
                rect.left <= window.innerWidth / 2 &&
                rect.right >= window.innerWidth / 2
            );
        });
        var fixedTopOverlayBottom = topOverlays.reduce(function (bottom, element) {
            return Math.max(bottom, element.getBoundingClientRect().bottom);
        }, 0);
        var uniqueElements = function (selector) {
            return Array.from(new Set(document.querySelectorAll(selector)));
        };
        var headings = uniqueElements('h1, [role="heading"][aria-level="1"]');
        var breadcrumbs = uniqueElements(
            '[itemtype$="/BreadcrumbList"], [aria-label*="breadcrumb" i], ' +
                '[class*="breadcrumb" i]',
        );
        var inspectLandmarks = function (elements) {
            var visible = elements.filter(function (element) {
                return inspectGeometry(element).visible;
            });
            var overlappedTops = [];
            visible.forEach(function (landmark) {
                var landmarkRect = landmark.getBoundingClientRect();
                var overlaps = topOverlays.some(function (overlay) {
                    if (
                        overlay === landmark ||
                        overlay.contains(landmark) ||
                        landmark.contains(overlay)
                    ) {
                        return false;
                    }
                    var overlayRect = overlay.getBoundingClientRect();
                    return (
                        overlayRect.left < landmarkRect.right &&
                        overlayRect.right > landmarkRect.left &&
                        overlayRect.top < landmarkRect.bottom &&
                        overlayRect.bottom > landmarkRect.top
                    );
                });
                if (overlaps) overlappedTops.push(landmarkRect.top);
            });
            return { visibleCount: visible.length, overlappedTops: overlappedTops };
        };
        var headingResult = inspectLandmarks(headings);
        var breadcrumbResult = inspectLandmarks(breadcrumbs);
        var allOverlappedTops = headingResult.overlappedTops.concat(
            breadcrumbResult.overlappedTops,
        );
        var targetGeometry = targetElements.map(inspectGeometry);
        var visibleTargetGeometry = targetGeometry.filter(function (geometry) {
            return geometry.visible;
        });
        var semanticFamilyClass = /(^|[-_])(ad|ads|advert|advertisement|slot|banner|sponsor)([-_]|$)/i;
        var isSemanticFamilyClass = function (className) {
            var normalizedClassName = className.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
            return semanticFamilyClass.test(normalizedClassName);
        };
        var familyProbeLimit = 128;
        var allFamilyCandidates = targetElements.length > 0
            ? Array.prototype.slice
                .call(targetElements[0].classList || [])
                .map(function (className) {
                    var elements = Array.prototype.slice.call(
                        document.getElementsByClassName(className),
                    );
                    return {
                        className: className,
                        elements: elements,
                        semantic: isSemanticFamilyClass(className),
                    };
                })
                .filter(function (candidate) {
                    return (
                        candidate.elements.length >= targetElements.length &&
                        targetElements.every(function (target) {
                            return candidate.elements.indexOf(target) >= 0;
                        })
                    );
                })
                .sort(function (left, right) {
                    if (left.elements.length !== right.elements.length) {
                        return right.elements.length - left.elements.length;
                    }
                    return left.className < right.className
                        ? -1
                        : left.className > right.className
                            ? 1
                            : 0;
                })
            : [];
        var semanticFamilyCandidates = allFamilyCandidates.filter(function (candidate) {
            return candidate.semantic;
        });
        var selectorClassNames = [];
        var selectorClassPattern = /[.]([A-Za-z_-][A-Za-z0-9_-]*)/g;
        var selectorClassMatch;
        while (
            (selectorClassMatch = selectorClassPattern.exec(String(targetSelector || ''))) !== null
        ) {
            selectorClassNames.push(selectorClassMatch[1]);
        }
        var selectorSemanticFamilyCandidate = semanticFamilyCandidates.find(function (candidate) {
            return selectorClassNames.indexOf(candidate.className) >= 0;
        });
        var lockedSelectorSemanticFamilyCandidate =
            selectorSemanticFamilyCandidate &&
            !semanticFamilyCandidates.some(function (candidate) {
                return candidate.elements.length > selectorSemanticFamilyCandidate.elements.length;
            })
                ? selectorSemanticFamilyCandidate
                : null;
        var selectedFamilyCandidate = lockedSelectorSemanticFamilyCandidate ||
            (semanticFamilyCandidates.length > 0
                ? semanticFamilyCandidates[0]
                : allFamilyCandidates.length > 0
                    ? allFamilyCandidates[0]
                    : null);
        var broaderCoMemberCandidate =
            lockedSelectorSemanticFamilyCandidate
            ? null
            : allFamilyCandidates.find(function (candidate) {
                return (
                    !selectedFamilyCandidate ||
                    candidate.elements.length > selectedFamilyCandidate.elements.length
                );
            });
        if (broaderCoMemberCandidate) selectedFamilyCandidate = broaderCoMemberCandidate;
        var targetFamilyClass = selectedFamilyCandidate
            ? selectedFamilyCandidate.className
            : null;
        var familyProbeTruncated = Boolean(
            selectedFamilyCandidate && selectedFamilyCandidate.elements.length > familyProbeLimit,
        );
        var familyTargetCount = selectedFamilyCandidate
            ? selectedFamilyCandidate.elements.length
            : targetElements.length;
        var familyTargetElements = familyProbeTruncated
            ? []
            : selectedFamilyCandidate
                ? selectedFamilyCandidate.elements
                : targetElements;
        var familyTargetGeometry = familyTargetElements.map(inspectGeometry);
        var visibleFamilyTargetGeometry = familyTargetGeometry.filter(function (geometry) {
            return geometry.visible;
        });
        var buildTargetMeasurements = function (elements, geometries) {
            return elements.map(function (element, index) {
                return {
                    key: elementKey(element),
                    width: geometries[index].rawWidth,
                    height: geometries[index].rawHeight,
                };
            });
        };
        var textElements = Array.prototype.slice
            .call(document.querySelectorAll('h1, h2, h3, p, li, blockquote, figcaption'))
            .filter(function (element) {
                return (element.innerText || '').trim().length >= 20;
            });
        var mediaElements = Array.prototype.slice
            .call(document.querySelectorAll('img, video, audio'))
            .filter(function (element) {
                var rect = element.getBoundingClientRect();
                if (rect.width < 32 || rect.height < 32) return false;
                if (element.tagName !== 'IMG') return true;
                return Boolean(
                    (element.getAttribute('alt') || '').trim() ||
                        element.closest('main, article, [role="main"]'),
                );
            });
        var controlElements = Array.prototype.slice.call(
            document.querySelectorAll(
                'button, input:not([type="hidden"]), select, textarea, summary, [role="button"]',
            ),
        );
        return {
            probeSucceeded: true,
            targetCount: targetElements.length,
            targetVisibleCount: visibleTargetGeometry.length,
            targetTotalHeight: visibleTargetGeometry.reduce(function (total, geometry) {
                return total + geometry.rawHeight;
            }, 0),
            targetTotalArea: visibleTargetGeometry.reduce(function (total, geometry) {
                return total + geometry.rawArea;
            }, 0),
            targetMaximumHeight: visibleTargetGeometry.reduce(function (maximum, geometry) {
                return Math.max(maximum, geometry.rawHeight);
            }, 0),
            targetFamilyClass: targetFamilyClass,
            familyProbeTruncated: familyProbeTruncated,
            familyTargetCount: familyTargetCount,
            familyTargetVisibleCount: visibleFamilyTargetGeometry.length,
            familyTargetTotalHeight: visibleFamilyTargetGeometry.reduce(function (
                total,
                geometry,
            ) {
                return total + geometry.rawHeight;
            }, 0),
            familyTargetMaximumHeight: visibleFamilyTargetGeometry.reduce(function (
                maximum,
                geometry,
            ) {
                return Math.max(maximum, geometry.rawHeight);
            }, 0),
            targetMeasurements: buildTargetMeasurements(targetElements, targetGeometry),
            familyTargetMeasurements: buildTargetMeasurements(
                familyTargetElements,
                familyTargetGeometry,
            ),
            documentTimeOrigin:
                typeof performance === 'object' && Number.isFinite(performance.timeOrigin)
                    ? Math.max(0, performance.timeOrigin)
                    : 0,
            documentHeight: Math.max(
                document.documentElement.scrollHeight || 0,
                document.body ? document.body.scrollHeight || 0 : 0,
            ),
            fixedTopOverlayBottom: Math.max(0, fixedTopOverlayBottom),
            visibleHeadingCount: headingResult.visibleCount,
            visibleBreadcrumbCount: breadcrumbResult.visibleCount,
            overlappedHeadingCount: headingResult.overlappedTops.length,
            overlappedBreadcrumbCount: breadcrumbResult.overlappedTops.length,
            minimumOverlappedLandmarkTop:
                allOverlappedTops.length > 0 ? Math.min.apply(null, allOverlappedTops) : null,
            meaningfulTextLength: (document.body.innerText || '').trim().length,
            textGeometry: summarizeGeometry(textElements),
            mediaGeometry: summarizeGeometry(mediaElements),
            controlGeometry: summarizeGeometry(controlElements),
        };
    } catch (_error) {
        return {
            probeSucceeded: false,
            targetCount: 0,
            targetVisibleCount: 0,
            targetTotalHeight: 0,
            targetTotalArea: 0,
            targetMaximumHeight: 0,
            targetFamilyClass: null,
            familyProbeTruncated: false,
            familyTargetCount: 0,
            familyTargetVisibleCount: 0,
            familyTargetTotalHeight: 0,
            familyTargetMaximumHeight: 0,
            targetMeasurements: [],
            familyTargetMeasurements: [],
            documentTimeOrigin: 0,
            documentHeight: 0,
            fixedTopOverlayBottom: 0,
            visibleHeadingCount: 0,
            visibleBreadcrumbCount: 0,
            overlappedHeadingCount: 0,
            overlappedBreadcrumbCount: 0,
            minimumOverlappedLandmarkTop: null,
            meaningfulTextLength: 0,
            textGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
            mediaGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
            controlGeometry: {
                totalCount: 0,
                visibleCount: 0,
                visibleArea: 0,
                clippedCount: 0,
                occludedCount: 0,
            },
        };
    }
})(__SELECTOR__)
`;

/**
 * Create the conservative result used when browser structure could not be measured.
 *
 * @returns A failed structural snapshot that can never authorize verification.
 */
function unavailableStructuralSnapshot(): StructuralSnapshot {
    return {
        probeSucceeded: false,
        targetCount: 0,
        targetVisibleCount: 0,
        targetTotalHeight: 0,
        targetTotalArea: 0,
        targetMaximumHeight: 0,
        targetFamilyClass: null,
        familyProbeTruncated: false,
        familyTargetCount: 0,
        familyTargetVisibleCount: 0,
        familyTargetTotalHeight: 0,
        familyTargetMaximumHeight: 0,
        targetMeasurements: [],
        familyTargetMeasurements: [],
        documentTimeOrigin: 0,
        documentHeight: 0,
        fixedTopOverlayBottom: 0,
        visibleHeadingCount: 0,
        visibleBreadcrumbCount: 0,
        overlappedHeadingCount: 0,
        overlappedBreadcrumbCount: 0,
        minimumOverlappedLandmarkTop: null,
        meaningfulTextLength: 0,
        textGeometry: {
            totalCount: 0,
            visibleCount: 0,
            visibleArea: 0,
            clippedCount: 0,
            occludedCount: 0,
        },
        mediaGeometry: {
            totalCount: 0,
            visibleCount: 0,
            visibleArea: 0,
            clippedCount: 0,
            occludedCount: 0,
        },
        controlGeometry: {
            totalCount: 0,
            visibleCount: 0,
            visibleArea: 0,
            clippedCount: 0,
            occludedCount: 0,
        },
    };
}

/**
 * Measure selector scope and semantic landmarks on the currently rendered page.
 *
 * @param evaluator - Trusted isolated-world page evaluator.
 * @param selector - Exact selector extracted from the candidate rule.
 * @returns A validated snapshot, or a conservative failed snapshot on any probe problem.
 */
export async function probeStructuralSnapshot(
    evaluator: TrustedPageEvaluator,
    selector: string,
): Promise<StructuralSnapshot> {
    const expression = STRUCTURAL_SNAPSHOT_PROBE.replace('__SELECTOR__', JSON.stringify(selector));
    try {
        const raw = await evaluator.evaluate(expression);
        const parsed = v.safeParse(StructuralSnapshotSchema, raw);
        return parsed.success ? parsed.output : unavailableStructuralSnapshot();
    } catch {
        return unavailableStructuralSnapshot();
    }
}

/**
 * Convert a trusted structural snapshot into the selector's rendered presence.
 *
 * @param snapshot - Runner-owned structural measurements.
 * @returns A conservative ad-element presence classification.
 */
export function presenceFromStructuralSnapshot(snapshot: StructuralSnapshot): AdElementPresence {
    if (!snapshot.probeSucceeded) {
        return AdElementPresence.NotProbed;
    }
    if (snapshot.targetCount === 0) {
        return AdElementPresence.NotFound;
    }
    if (snapshot.targetVisibleCount === snapshot.targetCount) {
        return AdElementPresence.Visible;
    }
    if (snapshot.targetVisibleCount === 0) {
        return AdElementPresence.Hidden;
    }
    return AdElementPresence.NotProbed;
}
