/**
 * Marker uBlock Origin writes in place of a site's public suffix to scope a rule to an entity.
 *
 * `shellshock.*` is one entity scope: the same registrable name under every public suffix it is
 * registered in, so one entry covers `shellshock.io`, `shellshockers.com` and `www.shellshock.io`.
 */
const ENTITY_SCOPE_MARKER = '.*';

/**
 * Narrowest public suffix an entity scope is resolved against, in DNS labels.
 *
 * Every hostname ends in at least one suffix label, so at least one label is always dropped when
 * looking for the entity name a hostname carries.
 */
const MIN_PUBLIC_SUFFIX_LABELS = 1;

/**
 * Widest public suffix an entity scope is resolved against, in DNS labels.
 *
 * The `*` is resolved against uBlock Origin's public-suffix list. This repository ships no
 * public-suffix data and must not gain a dependency for it, so the suffix is bounded by length
 * instead: one label (`com`, `io`) or two (`co.uk`, `com.br`). Nothing wider is admitted — a
 * three-label drop would let the leading label of an ordinary hostname pass as an entity name, so
 * `ads.example.com` would read as the entity `ads`.
 */
const MAX_PUBLIC_SUFFIX_LABELS = 2;

/**
 * Label length of a country-code top-level domain, the only final label a two-label public suffix
 * is admitted with.
 *
 * Every two-label public suffix a filter list scopes an entity across ends in a country code —
 * `co.uk`, `com.br`, `com.au`. Without that bound the two-label drop cannot tell `example.co.uk`,
 * which `example.*` does cover, from `shellshock.io.example`, whose registrable domain is
 * `io.example` and which the entity `shellshock.*` does not cover.
 */
const COUNTRY_CODE_TLD_LABEL_LENGTH = 2;

/**
 * Split a hostname into its lowercase DNS labels.
 *
 * @param hostname - Hostname, possibly with surrounding whitespace or a trailing root dot.
 * @returns The non-empty labels, most significant last.
 */
function hostnameLabels(hostname: string): string[] {
    return hostname
        .trim()
        .toLowerCase()
        .replace(/\.$/u, '')
        .split('.')
        .filter((label) => label.length > 0);
}

/**
 * Return what a hostname leaves behind once an admitted public suffix is dropped.
 *
 * Each remainder is one reading of where the hostname's registrable name ends: the one-label
 * reading is always admitted, the two-label one only when the hostname's final label is
 * country-code shaped.
 *
 * @param labels - The hostname's DNS labels.
 * @returns Remainders from the longest to the shortest; a drop consuming every label is omitted.
 */
function publicSuffixStrippedForms(labels: string[]): string[] {
    const finalLabel = labels.at(-1);
    const widestSuffix =
        finalLabel !== undefined && finalLabel.length === COUNTRY_CODE_TLD_LABEL_LENGTH
            ? MAX_PUBLIC_SUFFIX_LABELS
            : MIN_PUBLIC_SUFFIX_LABELS;
    const forms: string[] = [];
    for (let dropped = MIN_PUBLIC_SUFFIX_LABELS; dropped <= widestSuffix; dropped += 1) {
        const remainder = labels.slice(0, -dropped);
        if (remainder.length > 0) {
            forms.push(remainder.join('.'));
        }
    }
    return forms;
}

/**
 * Return the entity name a domain entry scopes a rule to.
 *
 * @param scope - Normalized domain entry, negation marker already stripped.
 * @returns The name before the entity marker, or undefined when the entry is not an entity form.
 */
function entityScopeBase(scope: string): string | undefined {
    const normalized = scope.trim().toLowerCase();
    if (!normalized.endsWith(ENTITY_SCOPE_MARKER)) {
        return undefined;
    }
    const base = normalized.slice(0, -ENTITY_SCOPE_MARKER.length);
    return base.length > 0 ? base : undefined;
}

/**
 * Return every registrable domain a hostname can be read as under the bounded suffix approximation.
 *
 * Because the public suffix is approximated by length rather than looked up, a hostname with three
 * or more labels and a country-code-shaped final label has two readings — `www.site.bbs.tr` is
 * either `bbs.tr` or `site.bbs.tr` — and both are returned, widest first.
 *
 * @param hostname - Queried hostname.
 * @returns The candidate registrable domains; empty when the hostname carries no label beyond an
 *   admitted public suffix.
 */
function registrableDomainForms(hostname: string): string[] {
    const labels = hostnameLabels(hostname);
    return publicSuffixStrippedForms(labels).map((remainder) => {
        const remainderLabelCount = remainder.split('.').length;
        return labels.slice(remainderLabelCount - 1).join('.');
    });
}

/**
 * Whether two hostnames belong to the same site under the bounded suffix approximation.
 *
 * One agreeing reading is enough. That is the conservative direction for a caller asking this in
 * order to treat a foreign host differently from the page's own: an over-wide suffix reading makes
 * two unrelated hostnames look related and so withholds the foreign-host treatment, whereas the
 * opposite error would grant it to the page's own site.
 *
 * @param hostname - One queried hostname.
 * @param other - The hostname it is compared against.
 * @returns Whether some reading of both hostnames names the same registrable domain.
 */
export function sharesRegistrableDomain(hostname: string, other: string): boolean {
    const forms = registrableDomainForms(hostname);
    const otherForms = registrableDomainForms(other);
    return forms.some((form) => otherForms.includes(form));
}

/**
 * Whether a domain entry names an entity instead of one concrete domain.
 *
 * @param scope - Normalized domain entry, negation marker already stripped.
 * @returns Whether the entry is uBlock Origin's `name.*` entity form.
 */
export function isEntityScope(scope: string): boolean {
    return entityScopeBase(scope) !== undefined;
}

/**
 * Decide whether one positive domain scope of a rule covers a queried hostname.
 *
 * An ordinary entry covers the hostname it names and every subdomain of it. An entity entry covers
 * the same registrable name under any public suffix, so it covers the hostname when dropping that
 * hostname's public suffix leaves the entity name or a subdomain of it — which is how
 * `shellshock.*` reaches `shellshock.io`, `www.shellshock.io` and `shellshock.co.uk` alike.
 *
 * @param scope - Normalized positive domain entry; the caller strips any `~` negation marker.
 * @param hostname - Queried hostname.
 * @returns Whether a rule carrying that entry applies to the hostname.
 */
export function domainScopeCovers(scope: string, hostname: string): boolean {
    const labels = hostnameLabels(hostname);
    if (labels.length === 0) {
        return false;
    }
    const normalizedHostname = labels.join('.');
    const entityBase = entityScopeBase(scope);
    if (entityBase !== undefined) {
        return publicSuffixStrippedForms(labels).some(
            (form) => form === entityBase || form.endsWith(`.${entityBase}`),
        );
    }
    const normalizedScope = scope.trim().toLowerCase();
    return (
        normalizedScope.length > 0 &&
        (normalizedHostname === normalizedScope ||
            normalizedHostname.endsWith(`.${normalizedScope}`))
    );
}

/**
 * Return a hostname and its meaningful parent hostnames.
 *
 * The final single-label suffix is excluded because matching every rule that mentions `com` or a
 * country-code suffix would make hostname matching unusably broad.
 *
 * @param hostname - Queried hostname.
 * @returns Hostname suffixes from most specific to least specific.
 */
export function hostnameAndParentSuffixes(hostname: string): string[] {
    const labels = hostnameLabels(hostname);
    if (labels.length <= 1) {
        return labels.length === 1 ? [labels.join('.')] : [];
    }
    return labels.slice(0, -1).map((_label, index) => labels.slice(index).join('.'));
}

/**
 * Build the raw-line search terms that can identify a rule scoped to a queried hostname.
 *
 * Alongside the hostname and its parents, the terms carry the entity forms those hostnames can be
 * written as: a rule scoped `shellshock.*` spells out no hostname a `shellshock.io` search would
 * otherwise look for, so without the entity terms a raw-line pre-filter drops the very rule that
 * already covers the site. The terms only pre-select lines worth normalizing —
 * {@link domainScopeCovers} stays authoritative about whether a rule really applies.
 *
 * @param hostname - Queried hostname.
 * @returns Deduplicated lowercase terms, most specific first.
 */
export function domainScopeSearchTerms(hostname: string): string[] {
    const suffixes = hostnameAndParentSuffixes(hostname);
    const entityTerms = suffixes.flatMap((suffix) =>
        publicSuffixStrippedForms(hostnameLabels(suffix)).map(
            (base) => `${base}${ENTITY_SCOPE_MARKER}`,
        ),
    );
    return Array.from(new Set([...suffixes, ...entityTerms]));
}
