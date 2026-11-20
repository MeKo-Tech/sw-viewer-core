// Bounded inflater and the error type shared by both container readers (container.ts
// for the 2015+ archive, ole.ts for the OLE2 compound file). Kept apart so that ole.ts
// does not import container.ts, which imports ole.ts.

/** Hard cap on an entry's declared uncompressed size, so a crafted file can't make
 *  the inflater allocate gigabytes. Real DisplayLists stay far below this. */
export const MAX_ENTRY_SIZE = 256 * 1024 * 1024;

export class SwContainerError extends Error {
  override name = "SwContainerError";
}

/** Inflates `data` (raw DEFLATE or zlib) into at most `limit` bytes. Stops reading and
 *  throws as soon as the output would exceed `limit`, so a DEFLATE bomb never gets
 *  buffered. Returns fewer bytes if the stream ends early; the caller checks that. */
export const inflateBounded = async (
  data: Uint8Array,
  limit: number,
  name: string,
  format: "deflate-raw" | "deflate" = "deflate-raw"
) => {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(format))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.length > limit) {
      await reader.cancel().catch(() => {});
      throw new SwContainerError(
        `entry "${name}" inflates to more than its declared ${limit} bytes`
      );
    }
    chunks.push(value);
    total += value.length;
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
