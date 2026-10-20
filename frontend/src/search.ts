export function searchQuery(search: string): string {
  return new URLSearchParams(search).get("tags")?.trim().replace(/\s+/g, " ") ?? "";
}

export function searchPath(tags: string): string {
  return "/search?" + new URLSearchParams({ tags: tags.trim().replace(/\s+/g, " ") });
}
