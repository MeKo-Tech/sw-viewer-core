const unicode = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });

/** Reads a Unicode MFC CString, including the extended UTF-16 code-unit counts. */
export const readMfcUnicodeString = (stream: Uint8Array, offset: number) => {
  if (
    offset < 0 ||
    offset + 4 > stream.length ||
    stream[offset] !== 0xff ||
    stream[offset + 1] !== 0xfe ||
    stream[offset + 2] !== 0xff
  ) {
    return undefined;
  }
  let length = stream[offset + 3];
  let start = offset + 4;
  if (length === 0xff) {
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    if (start + 2 > stream.length) return undefined;
    length = view.getUint16(start, true);
    start += 2;
    if (length === 0xffff) {
      if (start + 4 > stream.length) return undefined;
      length = view.getUint32(start, true);
      start += 4;
    }
  }
  const nextOffset = start + 2 * length;
  if (nextOffset > stream.length) return undefined;
  try {
    return { value: unicode.decode(stream.subarray(start, nextOffset)), nextOffset };
  } catch {
    return undefined;
  }
};
