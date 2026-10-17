import { describe, expect, it } from 'vitest';
import { CLOAKBROWSER_AUTO_UPDATE_VAR } from '../../../src/browser/cloakbrowser-auto-update';
import { resolveCloakBrowserAutoUpdate } from '../../../lab/local/cloakbrowser-auto-update';

describe('resolveCloakBrowserAutoUpdate', () => {
    it('defaults to false when unset', () => {
        expect(resolveCloakBrowserAutoUpdate({})).toBe('false');
    });

    it('keeps an explicit value', () => {
        expect(resolveCloakBrowserAutoUpdate({ [CLOAKBROWSER_AUTO_UPDATE_VAR]: 'true' })).toBe(
            'true',
        );
    });
});
