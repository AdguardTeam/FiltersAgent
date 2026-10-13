/**
 * Lowercase hexadecimal Git object identifier, as `git rev-parse` prints one.
 *
 * The width is a range because Git names objects with a SHA-1 in a classic repository (40 hex
 * characters) and with a SHA-256 in a `sha256`-format one (64), and a checkout may be either. The
 * same identifiers are read back when a candidate is bound to its source checkout and then written
 * into the published evidence manifest, so binding and publication have to accept exactly the same
 * vocabulary: pinning one side to a single width would let an object id pass the bind and then fail
 * validation at publication time, after the run is already finished.
 */
export const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;
