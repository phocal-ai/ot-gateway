/**
 * Config slugs from free-text names. On its own so that the points list reader, EDE files, profiles and
 * discovery can all use it without importing each other.
 */

/** A config slug (lowercase, digits, `-` and `_`, at most 64) from a free-text name; empty when nothing is left. */
export const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")
