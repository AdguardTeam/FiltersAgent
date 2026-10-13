/**
 * Repo-level boundary scan for the prompt documents: oxlint parses only JS/TS sources, so the src/
 * prompt Markdown keeps its own check instead of staying outside every gate.
 *
 * The scan walks `src/prompts/documents/` below one root (the first command-line argument, the
 * repository containing this script when absent) and fails naming every `.md` file that mentions
 * the lab-registered executor vocabulary. Per-executor routing prose lives where the registry can
 * own it — the registering executor module's selection guidance, under `lab/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Case-insensitive needle of the lab-registered executor vocabulary, the same one the parsed-source
 * oxlint rule enforces; the scan just reaches the Markdown that oxlint cannot parse.
 */
const NEEDLE = /adguard_cli/i;

/**
 * Repository-relative directory the scan walks below the scanned root.
 */
const DOCUMENTS_DIR = 'src/prompts/documents';

/**
 * Extension of every scanned document.
 */
const MARKDOWN_EXTENSION = '.md';

/**
 * Collect every scanned-document path below one directory, sorted for stable output.
 *
 * @param directory - Directory to walk recursively.
 * @returns Absolute paths of every Markdown file in the directory and its subdirectories.
 */
function collectMarkdownFiles(directory) {
    const collected = [];
    for (const entry of readdirSync(directory)) {
        const entryPath = join(directory, entry);
        if (statSync(entryPath).isDirectory()) {
            collected.push(...collectMarkdownFiles(entryPath));
        } else if (entry.endsWith(MARKDOWN_EXTENSION)) {
            collected.push(entryPath);
        }
    }
    return collected.sort();
}

/**
 * Resolve the scanned root: the first command-line argument, so fixtures drive the scan in tests,
 * or the repository containing this script.
 *
 * @returns Absolute root whose `src/prompts/documents` the scan covers.
 */
function scannedRoot() {
    const scriptDirectory = dirname(fileURLToPath(import.meta.url));
    return resolve(process.argv[2] ?? join(scriptDirectory, '..'));
}

const root = scannedRoot();
const documentsDir = join(root, DOCUMENTS_DIR);
const documents = collectMarkdownFiles(documentsDir);
const violations = documents.filter((path) => NEEDLE.test(readFileSync(path, 'utf8')));

if (violations.length === 0) {
    console.log(`prompt documents boundary scan passed (${documents.length} documents).`);
} else {
    for (const path of violations) {
        console.error(
            `${relative(root, path)}: mentions the lab-registered executor vocabulary ` +
                '(adguard_cli). Register executors in lab/ and keep the src/ prompts generic.',
        );
    }
    console.error(
        `prompt documents boundary scan failed: ${violations.length} of ${documents.length} ` +
            'documents mention the vocabulary.',
    );
    process.exitCode = 1;
}
