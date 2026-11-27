/** Escape user text without deleting its meaning or leaving recognizable system delimiters. */
export function escapePromptBoundaryTags(value: string): string {
  return value
    .replace(/<\/?origread_user_(?:skill|custom_instructions)\b[^>]*>/gi, (tag) => `&lt;${tag.slice(1)}`)
    .replace(/\[\/?ORIGREAD_(?:CONTEXT|EVIDENCE)\b[^\]]*\]/gi, (tag) => `&#91;${tag.slice(1)}`)
}
