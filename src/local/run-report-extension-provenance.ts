/**
 * The provenance lines naming the blocker one run executed with.
 *
 * The two launch families have nothing in common to print: the Chromium line loads an unpacked
 * AdGuard build and can name its directory and manifest generation, while a Firefox-family run
 * force-installs a signed XPI under a published extension id and has neither. A uBO run names uBO,
 * and nothing prints "AdGuard" or "Chromium + MV3 only" for it.
 */
import { ExtensionLaunchFamily } from '../environment/extension-launch';
import type { PreparedExtensionProvenance } from '../environment/environment-proofs';

/**
 * The support contract and blocker identity of one run, as report lines.
 *
 * @param extension - Prepared-build provenance, or absent when the run ran no blocker at all.
 * @returns The Markdown lines of the provenance block's blocker half.
 */
export function renderBlockerProvenance(
    extension: PreparedExtensionProvenance | null | undefined,
): string[] {
    if (extension?.launchFamily === ExtensionLaunchFamily.Firefox) {
        return [
            '- Browser support contract: `Firefox + signed XPI only`',
            '- Scope note: the blocker is force-installed through Firefox enterprise policies; ' +
                'its own extension pages cannot be driven, so its state is verified through the ' +
                'file the run instruction declares.',
            `- Blocker source: \`${extension.source}\``,
            `- Blocker extension id: \`${extension.extensionId ?? 'n/a'}\``,
            `- Signed XPI: \`${extension.xpiPath ?? 'n/a'}\``,
            `- Blocker tag: \`${extension.extensionSourceTag ?? 'n/a'}\``,
            `- Blocker source sha256: \`${extension.extensionSourceSha256}\``,
        ];
    }
    return [
        '- Browser support contract: `Chromium + MV3 only`',
        '- Scope note: this run does not verify branded Edge or Manifest V2 behavior.',
        `- Extension source: \`${extension?.source ?? 'n/a'}\``,
        `- Extension directory: \`${extension?.extensionPath ?? 'n/a'}\``,
        `- Extension tag: \`${extension?.extensionSourceTag ?? 'n/a'}\``,
        `- Extension source sha256: \`${extension?.extensionSourceSha256 ?? 'n/a'}\``,
        `- Manifest generation: \`${extension?.manifestVersion ?? 'n/a'}\``,
    ];
}
