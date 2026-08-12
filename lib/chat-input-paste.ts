export interface ClipboardItemLike {
  readonly type: string;
  getAsFile?: () => File | null;
}

export interface ClipboardClassification {
  hasText: boolean;
  hasImages: boolean;
  text: string;
  imageFiles: File[];
}

/** Replace the current textarea selection and return the caret after the paste. */
export function applyPastedText(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const nextValue = value.slice(0, start) + text + value.slice(end);
  return { value: nextValue, caret: start + text.length };
}

/** Separate text and image clipboard payloads without reading other formats. */
export function classifyClipboard(
  items: readonly ClipboardItemLike[],
  text: string,
): ClipboardClassification {
  const imageItems = items.filter((item) => item.type.startsWith("image/"));
  const imageFiles = imageItems
    .map((item) => item.getAsFile?.() ?? null)
    .filter((file): file is File => file !== null);

  return {
    hasText: text.length > 0,
    hasImages: imageItems.length > 0,
    text,
    imageFiles,
  };
}

export function clampTextareaHeight(scrollHeight: number, min = 24, max = 200): number {
  if (!Number.isFinite(scrollHeight)) return min;
  return Math.min(max, Math.max(min, scrollHeight));
}
