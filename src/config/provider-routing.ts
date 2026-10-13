import * as v from 'valibot';

/**
 * The gateway routing vocabulary: the one declaration of the upstream-provider preferences a
 * deployment may attach to every LLM request.
 *
 * It is an OpenAI-compatible GATEWAY feature, not a model one. OpenRouter routes a single model
 * slug across a dozen upstream providers and takes a `provider` object on every request to steer
 * that choice; pi forwards it verbatim from the catalog entry's `compat.openRouterRouting`, so what
 * this schema admits is exactly what lands on the wire. Other gateways ignore or reject an unknown
 * `provider` field, which is why the whole document is optional and absent by default — a
 * deployment sets it only when its gateway understands it.
 *
 * The document arrives as ONE JSON environment value and is validated here, at the boundary, and
 * strictly: a misspelled key fails the load loudly instead of being dropped into a request that
 * then routes exactly as it did before, leaving the operator believing a preference is in force
 * that no request ever carried. Downstream layers take the parsed value as given.
 */

/**
 * Maximum entries one provider list may carry.
 *
 * The lists name OpenRouter's upstream providers, of which its registry holds a few dozen, and a
 * routing preference is a short hand-written list: the one faulting provider to skip, the two to
 * prefer. 32 sits far above any real list and still keeps a pasted document from smuggling an
 * unbounded array onto every request of the run.
 */
const MAX_PROVIDER_LIST_ENTRIES = 32;

/**
 * Data-collection policy a routing document may require of the upstream providers.
 *
 * The two members are the gateway's own vocabulary: `allow` admits providers that may store or
 * train on request data, `deny` restricts routing to those that do not.
 */
export const RoutingDataCollection = {
    /**
     * Admit providers that may store or train on request data (the gateway's default).
     */
    Allow: 'allow',

    /**
     * Route only to providers that collect no request data.
     */
    Deny: 'deny',
} as const;

/**
 * RoutingDataCollection value.
 */
export type RoutingDataCollection =
    (typeof RoutingDataCollection)[keyof typeof RoutingDataCollection];

/**
 * Every RoutingDataCollection value, for schemas and exhaustive listings.
 */
export const ROUTING_DATA_COLLECTION_VALUES = Object.values(RoutingDataCollection);

/**
 * One list of upstream-provider slugs: non-empty names, bounded by
 * {@link MAX_PROVIDER_LIST_ENTRIES}. Shared by every list-valued routing field, which the gateway
 * shapes identically.
 */
const ProviderListSchema = v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1))),
    v.maxLength(MAX_PROVIDER_LIST_ENTRIES),
);

/**
 * The routing document as the environment carries it: a JSON string, parsed and validated against
 * the gateway's request fields.
 *
 * The field names are the gateway's snake_case wire spellings, kept verbatim because the parsed
 * object IS the request object — renaming them here would need a mapping table that a gateway
 * change could silently desynchronize. `sort` stays a free non-empty string rather than a picklist:
 * the sorting strategies (`price`, `throughput`, `latency`, …) are the gateway's own growing
 * vocabulary, so pinning a list here could only reject a strategy it has since added, and an
 * unknown one is rejected by the gateway itself.
 */
export const ProviderRoutingSchema = v.pipe(
    v.string(),
    v.parseJson(),
    v.strictObject({
        allow_fallbacks: v.optional(v.boolean()),
        require_parameters: v.optional(v.boolean()),
        data_collection: v.optional(v.picklist(ROUTING_DATA_COLLECTION_VALUES)),
        order: v.optional(ProviderListSchema),
        only: v.optional(ProviderListSchema),
        ignore: v.optional(ProviderListSchema),
        quantizations: v.optional(ProviderListSchema),
        sort: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
);

/**
 * A validated routing document, ready to be attached to a model's compatibility settings.
 */
export type ProviderRouting = v.InferOutput<typeof ProviderRoutingSchema>;
