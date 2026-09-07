// Verified against the provider's model descriptions and video endpoints.
const videoAliases = new Set(["lec-mj-wan-3-0-1080p", "lec-seed-2-0-900", "lec-seed-2-5-900"]);

export function isCustomVideoModel(model: string) {
    return videoAliases.has(model.trim().toLowerCase());
}
