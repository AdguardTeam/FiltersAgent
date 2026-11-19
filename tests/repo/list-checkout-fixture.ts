import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Create a temporary filters checkout holding the given list files.
 *
 * @param lists - The rules of each list file, keyed by its repository path.
 * @returns Absolute path of the checkout; the caller removes it.
 */
export function createListCheckout(lists: Readonly<Record<string, readonly string[]>>): string {
    const checkout = mkdtempSync(join(tmpdir(), 'list-checkout-'));
    for (const [filePath, rules] of Object.entries(lists)) {
        mkdirSync(join(checkout, dirname(filePath)), { recursive: true });
        writeFileSync(join(checkout, filePath), [...rules, ''].join('\n'));
    }
    return checkout;
}
