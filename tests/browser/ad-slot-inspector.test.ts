import { afterEach, describe, expect, it, vi } from 'vitest';
import { AD_SLOT_INSPECTION_EXPRESSION } from '../../src/browser/ad-slot-inspector';
import type { AdSlotScanResult } from '../../src/types/ad-slot-inspection';

interface FakeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface FakeElementOptions {
    id?: string;
    classes?: string[];
    rect?: Partial<FakeRect>;
    style?: Record<string, string>;
    attributes?: Record<string, string>;
    text?: string;
}

class FakeElement {
    readonly tagName: string;
    readonly id: string;
    readonly classList: string[];
    readonly children: FakeElement[] = [];
    readonly childNodes: Array<{ nodeType: number; nodeValue: string }>;
    readonly attributes: Record<string, string>;
    readonly rect: FakeRect;
    readonly style: Record<string, string>;
    parentElement: FakeElement | null = null;

    constructor(tag: string, options: FakeElementOptions = {}) {
        this.tagName = tag.toUpperCase();
        this.id = options.id ?? '';
        this.classList = options.classes ?? [];
        this.rect = {
            x: options.rect?.x ?? 0,
            y: options.rect?.y ?? 0,
            width: options.rect?.width ?? 0,
            height: options.rect?.height ?? 0,
        };
        this.style = options.style ?? {};
        this.attributes = options.attributes ?? {};
        this.childNodes = options.text ? [{ nodeType: 3, nodeValue: options.text }] : [];
    }

    append(...children: FakeElement[]): this {
        for (const child of children) {
            child.parentElement = this;
            this.children.push(child);
        }
        return this;
    }

    getBoundingClientRect(): Record<string, number> {
        const { x, y, width, height } = this.rect;
        return {
            x,
            y,
            top: y,
            right: x + width,
            bottom: y + height,
            left: x,
            width,
            height,
        };
    }

    hasAttribute(name: string): boolean {
        return Object.hasOwn(this.attributes, name);
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector !== '*') {
            throw new Error(`Unexpected selector: ${selector}`);
        }
        const descendants: FakeElement[] = [];
        const visit = (node: FakeElement): void => {
            for (const child of node.children) {
                descendants.push(child);
                visit(child);
            }
        };
        visit(this);
        return descendants;
    }
}

function getFixtureComputedStyle(node: FakeElement): Record<string, string> {
    return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        height: `${node.rect.height}px`,
        minHeight: '0px',
        maxHeight: 'none',
        backgroundImage: 'none',
        ...node.style,
    };
}

function executeFixture(root: FakeElement): AdSlotScanResult {
    const all = [root, ...root.querySelectorAll('*')];
    const document = {
        getElementsByTagName: (tag: string) => (tag === '*' ? all : []),
        documentElement: { clientWidth: 1280, clientHeight: 720 },
    };
    const window = { innerWidth: 1280, innerHeight: 720 };
    const inspect = new Function(
        'document',
        'window',
        'getComputedStyle',
        'Node',
        `return (${AD_SLOT_INSPECTION_EXPRESSION});`,
    );
    return inspect(document, window, getFixtureComputedStyle, {
        TEXT_NODE: 3,
    }) as AdSlotScanResult;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('AD_SLOT_INSPECTION_EXPRESSION', () => {
    it('returns both a tall ad wrapper and its empty GAM child with the full ancestor link', () => {
        const html = new FakeElement('html', { rect: { width: 1280, height: 1200 } });
        const body = new FakeElement('body', { rect: { width: 1280, height: 1200 } });
        const article = new FakeElement('article', {
            classes: ['single-post-top-ad'],
            rect: { x: 120, y: 100, width: 1040, height: 400 },
            style: { minHeight: '400px' },
        });
        const gam = new FakeElement('div', {
            id: 'div-gpt-ad-top',
            rect: { x: 120, y: 100, width: 1040, height: 0 },
            attributes: { 'data-ad-slot': '/123/top' },
        });
        html.append(body.append(article.append(gam)));

        const result = executeFixture(html);

        expect(result).toMatchObject({
            scope: 'main_frame_light_dom',
            candidateCount: 2,
            returnedCount: 2,
            truncated: false,
        });
        expect(result.slots[0]).toMatchObject({
            element: {
                tag: 'article',
                classes: ['single-post-top-ad'],
                viewportRect: { height: 400 },
                visibility: { state: 'visible', occupiesLayoutSpace: true },
            },
            contentState: 'empty',
            descendantCount: 1,
        });
        const child = result.slots.find((slot) => slot.element.id === 'div-gpt-ad-top');
        expect(child).toMatchObject({
            contentState: 'empty',
            element: { visibility: { state: 'zero_area' } },
            ancestors: expect.arrayContaining([
                expect.objectContaining({
                    tag: 'article',
                    classes: ['single-post-top-ad'],
                    viewportRect: expect.objectContaining({ height: 400 }),
                }),
            ]),
        });
    });

    it('inspects at most 256 candidates, returns 32, and marks truncation', () => {
        const html = new FakeElement('html', { rect: { width: 1280, height: 2000 } });
        const body = new FakeElement('body', { rect: { width: 1280, height: 2000 } });
        html.append(body);
        body.append(
            ...Array.from(
                { length: 300 },
                (_, index) =>
                    new FakeElement('div', {
                        id: `ad-${index}`,
                        rect: { y: index, width: 300, height: 100 },
                    }),
            ),
        );

        const result = executeFixture(html);

        expect(result.candidateCount).toBe(300);
        expect(result.returnedCount).toBe(32);
        expect(result.slots).toHaveLength(32);
        expect(result.truncated).toBe(true);
    });

    it('returns unknown when the bounded 128-descendant content scan is incomplete', () => {
        const html = new FakeElement('html', { rect: { width: 1280, height: 1200 } });
        const slot = new FakeElement('section', {
            classes: ['ad'],
            rect: { width: 1000, height: 300 },
        });
        slot.append(...Array.from({ length: 129 }, () => new FakeElement('div')));
        html.append(slot);

        const result = executeFixture(html);

        expect(result.slots[0]).toMatchObject({
            contentState: 'unknown',
            descendantCount: 129,
            contentScanTruncated: true,
        });
    });

    it('does not classify hidden or zero-area tracking media as rendered creative content', () => {
        const html = new FakeElement('html', { rect: { width: 1280, height: 1200 } });
        const slot = new FakeElement('section', {
            classes: ['ad'],
            rect: { width: 1000, height: 300 },
        });
        const zeroAreaImage = new FakeElement('img', {
            rect: { width: 0, height: 0 },
        });
        const hiddenAncestor = new FakeElement('div', {
            rect: { width: 300, height: 250 },
            style: { opacity: '0' },
        });
        const hiddenIframe = new FakeElement('iframe', {
            rect: { width: 300, height: 250 },
        });
        const hiddenBackground = new FakeElement('div', {
            rect: { width: 300, height: 250 },
            style: {
                visibility: 'hidden',
                backgroundImage: 'url("https://tracker.invalid/pixel")',
            },
        });
        hiddenAncestor.append(hiddenIframe);
        slot.append(zeroAreaImage, hiddenAncestor, hiddenBackground);
        html.append(slot);

        const result = executeFixture(html);

        expect(result.slots[0]).toMatchObject({
            contentState: 'empty',
            creativeSignals: [],
        });
    });

    it('classifies positive-area non-hidden rendered media as creative', () => {
        const html = new FakeElement('html', { rect: { width: 1280, height: 1200 } });
        const slot = new FakeElement('section', {
            classes: ['ad'],
            rect: { width: 1000, height: 300 },
        });
        slot.append(
            new FakeElement('iframe', {
                rect: { width: 300, height: 250 },
            }),
        );
        html.append(slot);

        const result = executeFixture(html);

        expect(result.slots[0]).toMatchObject({
            contentState: 'creative',
            creativeSignals: ['descendant-iframe'],
        });
    });

    it('sanitizes identifier controls and omits raw text, HTML, URLs, and other values', () => {
        const html = new FakeElement('html');
        html.append(
            new FakeElement('aside', {
                id: 'ad\u0000\r\n-slot',
                classes: ['advertisement\u001b'],
                text: 'PRIVATE USER TEXT',
                attributes: {
                    'data-ad-slot': 'https://secret.example/user-id',
                    href: 'https://secret.example/path',
                },
                rect: { width: 300, height: 250 },
            }),
        );

        const result = executeFixture(html);
        const serialized = JSON.stringify(result);

        expect(result.slots[0].element).toMatchObject({
            id: 'ad-slot',
            classes: ['advertisement'],
        });
        expect(serialized).not.toContain('\\u0000');
        expect(serialized).not.toContain('\\r');
        expect(serialized).not.toContain('\\n');
        expect(serialized).not.toContain('\\u001b');
        expect(serialized).not.toContain('PRIVATE USER TEXT');
        expect(serialized).not.toContain('secret.example');
        expect(serialized).not.toContain('<aside');
        expect(serialized).toContain('"meaningfulTextLength":17');
    });
});
