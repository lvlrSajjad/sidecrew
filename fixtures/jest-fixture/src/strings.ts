/** String utilities. Pure, total unless the doc comment says otherwise. */

/**
 * A URL-safe slug: lowercase, accents stripped, runs of non-alphanumerics collapsed to one dash,
 * no leading or trailing dash.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Shortens `text` to at most `maxLength` characters, ending with a one-character ellipsis when
 * anything was cut. Text that already fits is returned unchanged. `maxLength <= 0` gives "".
 */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length < maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/** Upper-cases the first letter of every whitespace-separated word and lower-cases the rest. */
export function titleCase(input: string): string {
  return input.replace(/\S+/g, (word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`);
}

/** Non-overlapping occurrences of `needle` in `haystack`. An empty needle counts as none. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** The longest string that starts both `a` and `b`. */
export function commonPrefix(a: string, b: string): string {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}
