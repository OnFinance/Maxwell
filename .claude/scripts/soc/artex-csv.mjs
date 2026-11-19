import { parse } from 'csv-parse/sync';

export class ArtexError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const header = ["ID", "名称", "类别", "严重等级", "状态", "所属任务", "发现时间", "概述", "流量证据数量", "流量证据ID"];
const severities = new Set(["critical", "high", "medium", "low", "info"]);

export function readArtex(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 512 * 1024) throw new ArtexError("Choose an ARTEX findings CSV of at most 512 KiB.", 400);
  let records;
  try { records = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 65536 }); }
  catch { throw new ArtexError("Malformed ARTEX CSV. Check quoting and column counts.", 422); }
  if (JSON.stringify(records.shift()) !== JSON.stringify(header)) throw new ArtexError("Expected the RuoJi6 ARTEX v0.3.30 findings CSV header.", 422);
  if (records.length > 500) throw new ArtexError("Select at most 500 findings per export.", 413);
  const seen = new Set();
  return records.map((row, index) => {
    const [externalId, rawTitle, , severity, , , localTime, , count] = row;
    const title = rawTitle?.trim();
    if (!externalId || !/^(case:)?[1-9][0-9]{0,18}$/.test(externalId) || seen.has(externalId)) throw new ArtexError(`Row ${index + 2} has an invalid or duplicate ARTEX ID.`, 422);
    if (!title || title.length > 200 || /[\u0000-\u001f]/.test(title)) throw new ArtexError(`Row ${index + 2} needs a one-line title of at most 200 characters.`, 422);
    if (!severity || !severities.has(severity)) throw new ArtexError(`Row ${index + 2} needs an assessed severity. Review its rating in ARTEX and export again.`, 422);
    if (!count || !/^\d{1,9}$/.test(count) || !localTime || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localTime)) throw new ArtexError(`Row ${index + 2} has an invalid evidence count or discovery time.`, 422);
    seen.add(externalId);
    // Free-form summaries, task descriptions and traffic are intentionally excluded.
    return { externalId, title, severity, evidenceCount: Number(count), localTime };
  });
}
