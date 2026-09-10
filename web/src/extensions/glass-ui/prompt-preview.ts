const previewLength = 120;

/** Display-only summary. Copying, saving and model requests always use the original prompt. */
export function promptPreview(prompt: string): string {
    const text = prompt.replace(/\s+/gu, " ").trim();
    const characters = Array.from(text);
    return characters.length > previewLength ? `${characters.slice(0, previewLength).join("")}…` : text;
}
