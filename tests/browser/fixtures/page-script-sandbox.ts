import { runInNewContext } from 'node:vm';

/**
 * One element of a fake page: the few DOM members the runner's page scripts read.
 */
export interface FakeElement {
    /**
     * Upper-case tag name, as the DOM reports it.
     */
    tagName: string;

    /**
     * Element text.
     */
    textContent: string;

    /**
     * Attributes by name; scripts may add their own markers.
     */
    attributes: Record<string, string>;

    /**
     * Whether a script scrolled the element into view.
     */
    scrolledIntoView: boolean;
}

/**
 * Create a fake element.
 *
 * @param tagName - Upper-case tag name.
 * @param textContent - Element text.
 * @param attributes - Initial attributes.
 * @returns The element.
 */
export function fakeElement(
    tagName: string,
    textContent: string,
    attributes: Record<string, string> = {},
): FakeElement {
    return { tagName, textContent, attributes: { ...attributes }, scrolledIntoView: false };
}

/**
 * Present one fake element through the DOM members the page scripts call.
 *
 * @param element - The fake element.
 * @returns The DOM-shaped view scripts receive.
 */
function node(element: FakeElement): Record<string, unknown> {
    return {
        tagName: element.tagName,
        textContent: element.textContent,
        id: element.attributes.id ?? '',
        disabled: false,
        getAttribute: (name: string) => element.attributes[name] ?? null,
        setAttribute: (name: string, value: string) => {
            element.attributes[name] = value;
        },
        getBoundingClientRect: () => ({
            width: 100,
            height: 20,
            top: 0,
            left: 0,
            right: 100,
            bottom: 20,
        }),
        closest: () => null,
        querySelector: () => null,
        scrollIntoView: () => {
            element.scrolledIntoView = true;
        },
    };
}

/**
 * Evaluate a page script the way a browser does: as source text in a realm that shares nothing with
 * the module that built it, against a page holding `elements` that `selector` matches.
 *
 * Only the DOM surface the runner's scripts use is modelled. The point is the realm: a script that
 * names a module-scope constant throws here exactly as it throws in the page.
 *
 * @param expression - The page script.
 * @param selector - The one selector the fake page answers.
 * @param elements - Elements that selector matches.
 * @returns The script's value.
 */
export function evaluatePageScript(
    expression: string,
    selector: string,
    elements: FakeElement[],
): unknown {
    const document = {
        querySelector: (query: string) =>
            query === selector && elements[0] ? node(elements[0]) : null,
        querySelectorAll: (query: string) => (query === selector ? elements.map(node) : []),
    };
    return runInNewContext(expression, {
        document,
        atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
        getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    });
}
