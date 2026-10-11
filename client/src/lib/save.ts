/** Browser download helper (DOM-only, kept out of the SDK). */
export function saveJson(name: string, obj: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Plain-text download (JSONL logs etc.) — same blob dance as saveJson. */
export function saveText(name: string, text: string, mime = 'application/x-ndjson') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
