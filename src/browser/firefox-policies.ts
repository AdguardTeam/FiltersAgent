import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIREFOX_USER_FILTERS_KEY_PATH_MAX } from '../environment/extension-launch';

/**
 * Environment variable the patched Playwright Firefox build reads to locate a custom
 * `policies.json` (playwright PR #35926). The value must be an absolute file path; the variable is
 * consumed by the browser process, so the engine must pass it through the launch `env`.
 */
export const FIREFOX_POLICIES_ENV_VAR = 'PLAYWRIGHT_FIREFOX_POLICIES_JSON';

/**
 * Firefox enterprise `policies.json` payload.
 *
 * Shape per https://mozilla.github.io/policy-templates/: the file wraps everything in a top-level
 * `policies` object; `ExtensionSettings` force-installs signed XPIs and the `3rdparty.Extensions`
 * block feeds WebExtension managed storage.
 */
export interface FirefoxPolicies {
    /**
     * Enterprise policies handed to Firefox verbatim below the file's `policies` key.
     */
    policies: {
        /**
         * Per-extension installation directives keyed by extension ID (for example
         * `uBlock0@raymondhill.net`).
         */
        ExtensionSettings: {
            /**
             * Single extension directive: force-installed from a local signed XPI.
             */
            [extensionId: string]: {
                /**
                 * Declared verbatim from the Firefox policy template (`force_installed`).
                 */
                installation_mode: 'force_installed';

                /**
                 * Absolute `file://` URL of the signed XPI to install.
                 */
                install_url: string;
            };
        };

        /**
         * Managed storage per extension ID, following the template's `3rdparty` section. Absent
         * when the caller supplies no managed storage.
         */
        '3rdparty'?: {
            /**
             * Managed storage records keyed by the same extension ID as `ExtensionSettings`.
             */
            Extensions: {
                /**
                 * Application-managed data the extension reads from `browser.storage.managed`.
                 */
                [extensionId: string]: Record<string, unknown>;
            };
        };
    };
}

/**
 * Input for building a Firefox policies payload for one force-installed extension.
 */
export interface FirefoxPoliciesInput {
    /**
     * Extension ID the policies target (for example `uBlock0@raymondhill.net`).
     */
    extensionId: string;

    /**
     * Absolute filesystem path of the signed XPI the browser must force-install.
     */
    xpiPath: string;

    /**
     * Managed storage for the extension, passed through verbatim.
     *
     * For uBlock Origin this is `{ adminSettings: { userFilters, selectedFilterLists } }`, the
     * documented Firefox channel read from `browser.storage.managed`; the shape is owned by the
     * executor instruction, not by this module.
     */
    managedStorage?: Record<string, unknown>;
}

/**
 * Build the `policies.json` payload that force-installs a signed XPI with optional managed storage.
 * Pure function; the engine writes the result to disk and points the browser at it.
 *
 * @param input - Extension ID, absolute XPI path, and optional managed storage.
 * @returns The Enterprise `policies.json` payload ready to be serialized.
 * @throws When `xpiPath` is a relative path: Firefox's `install_url` must be an absolute `file://`
 *   URL, and a path-relative URL would silently point somewhere else depending on the working
 *   directory.
 */
export function buildFirefoxPolicies(input: FirefoxPoliciesInput): FirefoxPolicies {
    if (!isAbsolute(input.xpiPath)) {
        throw new Error(
            `xpiPath must be an absolute filesystem path; received relative: ${input.xpiPath}`,
        );
    }
    const policy: FirefoxPolicies = {
        policies: {
            ExtensionSettings: {
                [input.extensionId]: {
                    installation_mode: 'force_installed',
                    install_url: pathToFileURL(input.xpiPath).href,
                },
            },
        },
    };
    if (input.managedStorage !== undefined) {
        policy.policies['3rdparty'] = {
            Extensions: {
                [input.extensionId]: input.managedStorage,
            },
        };
    }
    return policy;
}

/**
 * Test whether one managed-storage node can carry named keys.
 *
 * @param value - Node found at one key-path segment.
 * @returns Whether the node is a plain keyed object (an array or a scalar cannot carry the path).
 */
function isKeyedNode(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Place the user-filters file content into the declared managed-storage key path.
 *
 * The instruction owns the managed-storage document and names the key that must hold the file's
 * content (`['adminSettings', 'userFilters']` for uBlock Origin); the host writes the file and
 * calls this before every launch, because Firefox reads the policies only at startup. The template
 * is deep-copied, so the declaration itself is never mutated and two launches of the same run
 * cannot leak one phase's rules into the next.
 *
 * @param template - Managed-storage document the instruction declared, without the user filters.
 * @param keyPath - Key path inside the template that must hold the file content.
 * @param content - Exact content of the declared user-filters file.
 * @returns A fresh managed-storage document carrying the content at the declared key path.
 * @throws When the key path is empty, longer than {@link FIREFOX_USER_FILTERS_KEY_PATH_MAX}, holds
 *   an empty segment, or crosses a node that cannot carry named keys — the launch would otherwise
 *   hand the extension a document whose user filters are somewhere else entirely.
 */
export function buildManagedStorageWithUserFilters(
    template: Record<string, unknown>,
    keyPath: readonly string[],
    content: string,
): Record<string, unknown> {
    if (keyPath.length === 0 || keyPath.length > FIREFOX_USER_FILTERS_KEY_PATH_MAX) {
        throw new Error(
            `The managed-storage user-filters key path must hold 1 to ` +
                `${FIREFOX_USER_FILTERS_KEY_PATH_MAX} segments; received ${keyPath.length}.`,
        );
    }
    if (keyPath.some((segment) => segment.length === 0)) {
        throw new Error(
            `The managed-storage user-filters key path holds an empty segment: ` +
                `[${keyPath.join(', ')}].`,
        );
    }
    const managedStorage = structuredClone(template) as Record<string, unknown>;
    let node = managedStorage;
    for (const [index, segment] of keyPath.slice(0, -1).entries()) {
        const next = node[segment];
        if (next === undefined) {
            const created: Record<string, unknown> = {};
            node[segment] = created;
            node = created;
            continue;
        }
        if (!isKeyedNode(next)) {
            throw new Error(
                `The managed-storage user-filters key path [${keyPath.join(', ')}] crosses ` +
                    `"${segment}" at depth ${index}, which holds ${typeof next} instead of an ` +
                    'object that can carry the remaining segments.',
            );
        }
        node = next;
    }
    node[keyPath[keyPath.length - 1]!] = content;
    return managedStorage;
}
