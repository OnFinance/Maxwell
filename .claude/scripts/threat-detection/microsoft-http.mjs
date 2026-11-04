// Bound decompressed response size, including when Content-Length is absent or false.
export async function readMicrosoftJson(response, maxBytes = 8388608) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty Microsoft response');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response size limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('invalid or oversized Microsoft JSON response');
  } finally { reader.releaseLock(); }
}
