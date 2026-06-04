import JSZip from 'jszip';
import { supabase, hasSupabase } from './supabase.js';

// ============================================================================
// Client-side file upload (Phase B). The app parses an EPUB / HTML / TXT file
// in the browser and inserts a `works` row (source='upload', origin='upload')
// plus its `chapters` directly with the anon key — no worker round-trip, since
// there's no URL to fetch. The Reader renders chapter `content` via
// dangerouslySetInnerHTML, so every chapter body is stored as HTML.
// ============================================================================

// ---- small text helpers ----------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function countWords(html) {
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}
function titleFromFilename(name) {
  return (name || 'Untitled').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
}

// Strip dangerous / unrenderable nodes from a parsed document fragment. The
// content is the user's own uploaded file (single-user private app), so this is
// light hygiene, not a hostile-input sanitizer: drop scripts/styles/embeds and
// inline-event attributes, and remove <img> whose sources point inside the
// EPUB zip and won't resolve at read time.
function cleanNode(root) {
  const KILL = ['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'img', 'svg', 'head'];
  root.querySelectorAll(KILL.join(',')).forEach(el => el.remove());
  root.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(a => {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || (n === 'href' && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    });
  });
}
function bodyHtml(doc) {
  const body = doc.body || doc.querySelector('body') || doc.documentElement;
  if (!body) return '';
  cleanNode(body);
  return (body.innerHTML || '').trim();
}

// Find a chapter title: an explicit heading, else the document <title>.
function headingText(doc) {
  const h = doc.querySelector('h1, h2, h3');
  const t = h && h.textContent.trim();
  if (t) return t;
  const dt = doc.querySelector('title');
  return (dt && dt.textContent.trim()) || '';
}

// localName-based lookup so we don't fight XML namespace prefixes (dc:, opf:).
function byTag(root, name) {
  const out = [];
  root.querySelectorAll('*').forEach(el => { if (el.localName && el.localName.toLowerCase() === name) out.push(el); });
  return out;
}
// Normalise an href relative to the OPF's directory ("OEBPS/text/c1.xhtml").
function resolvePath(baseDir, href) {
  const clean = href.split('#')[0].split('?')[0];
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// ---- EPUB -------------------------------------------------------------------
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const dom = new DOMParser();

  // 1. container.xml → OPF path
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Not a valid EPUB (no container.xml).');
  const container = dom.parseFromString(await containerFile.async('string'), 'application/xml');
  const rootfile = byTag(container, 'rootfile')[0];
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath) throw new Error('Not a valid EPUB (no rootfile).');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  // 2. OPF: metadata + manifest + spine
  const opf = dom.parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
  const title = (byTag(opf, 'title')[0]?.textContent || '').trim() || titleFromFilename(file.name);
  const author = (byTag(opf, 'creator')[0]?.textContent || '').trim();
  const descEl = byTag(opf, 'description')[0];
  const summary = descEl ? descEl.textContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

  // Series metadata so books auto-group: Calibre's <meta name="calibre:series">
  // / "calibre:series_index", or EPUB3's belongs-to-collection / group-position.
  const metas = byTag(opf, 'meta');
  const metaName = (n) => {
    const el = metas.find(m => (m.getAttribute('name') || '').toLowerCase() === n);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const metaProp = (p) => {
    const el = metas.find(m => (m.getAttribute('property') || '').toLowerCase() === p);
    return el ? (el.textContent || '').trim() : '';
  };
  const series = metaName('calibre:series') || metaProp('belongs-to-collection');
  const idxRaw = metaName('calibre:series_index') || metaProp('group-position');
  const seriesIndex = idxRaw && !Number.isNaN(parseFloat(idxRaw)) ? parseFloat(idxRaw) : null;

  const manifest = {}; // id -> { href, type }
  byTag(opf, 'item').forEach(it => {
    const id = it.getAttribute('id');
    if (id) manifest[id] = { href: it.getAttribute('href') || '', type: (it.getAttribute('media-type') || '').toLowerCase() };
  });
  const spine = byTag(opf, 'itemref').map(ref => ref.getAttribute('idref')).filter(Boolean);

  // 3. Walk the spine, pull each XHTML document's body as one chapter.
  const chapters = [];
  let n = 0;
  for (const idref of spine) {
    const item = manifest[idref];
    if (!item || !/x?html/.test(item.type)) continue;
    const path = resolvePath(opfDir, item.href);
    const entry = zip.file(path);
    if (!entry) continue;
    // Parse as text/html: tolerant of slightly-malformed XHTML and gives us the
    // same querySelector helpers regardless of the source markup flavour.
    const doc = dom.parseFromString(await entry.async('string'), 'text/html');
    const content = bodyHtml(doc);
    if (!content || countWords(content) < 3) continue; // skip covers / nav / blank pages
    n += 1;
    chapters.push({ n, title: headingText(doc) || `Chapter ${n}`, content, words: countWords(content) });
  }
  if (!chapters.length) throw new Error('No readable chapters found in this EPUB.');
  return { title, author, summary, series, seriesIndex, chapters };
}

// ---- HTML -------------------------------------------------------------------
async function parseHtmlFile(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
  const title = (doc.querySelector('title')?.textContent || '').trim()
    || (doc.querySelector('h1')?.textContent || '').trim()
    || titleFromFilename(file.name);
  const content = bodyHtml(doc);
  if (!content) throw new Error('That HTML file has no readable body.');
  return { title, author: '', summary: '', chapters: [{ n: 1, title, content, words: countWords(content) }] };
}

// ---- plain text -------------------------------------------------------------
async function parseTxtFile(file) {
  const raw = await file.text();
  // Blank-line-separated paragraphs → <p>. Preserves single line breaks as <br>.
  const html = raw.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  if (!html) throw new Error('That file is empty.');
  const title = titleFromFilename(file.name);
  return { title, author: '', summary: '', chapters: [{ n: 1, title, content: html, words: countWords(html) }] };
}

// ---- dispatch + insert ------------------------------------------------------
export function isSupportedUpload(file) {
  return /\.(epub|html?|txt)$/i.test(file?.name || '');
}

async function parseFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.epub')) return parseEpub(file);
  if (name.endsWith('.html') || name.endsWith('.htm')) return parseHtmlFile(file);
  if (name.endsWith('.txt')) return parseTxtFile(file);
  throw new Error('Unsupported file. Upload an EPUB, HTML, or TXT file.');
}

// Parse a file in the browser and store it as a fully-offline uploaded work.
// Returns { ok, work?, error? }.
export async function uploadFile(file) {
  if (!hasSupabase) return { ok: false, error: 'Connect your account first to enable uploads.' };
  if (!file) return { ok: false, error: 'No file chosen.' };

  let parsed;
  try {
    parsed = await parseFile(file);
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not read that file.' };
  }

  const totalWords = parsed.chapters.reduce((s, c) => s + (c.words || 0), 0);
  const now = new Date().toISOString();
  const workRow = {
    source: 'upload',
    source_work_id: `upload-${(crypto.randomUUID && crypto.randomUUID()) || Date.now()}`,
    origin: 'upload',
    title: parsed.title,
    author: parsed.author || '',
    summary: parsed.summary || '',
    words: totalWords,
    chapters: parsed.chapters.length,
    chapters_total: parsed.chapters.length,
    status: 'complete',
    updated_label: 'Uploaded',
    source_updated: now,
    palette: Math.floor(Math.random() * 6),
    offline: true,
    // Auto series grouping from EPUB metadata (still editable in the app).
    series_name: parsed.series || null,
    series_index: parsed.seriesIndex ?? null,
  };

  const { data: work, error: workErr } = await supabase.from('works').insert(workRow).select().single();
  if (workErr) return { ok: false, error: workErr.message || String(workErr) };

  const chapterRows = parsed.chapters.map(c => ({
    work_id: work.id, n: c.n, title: c.title || `Chapter ${c.n}`,
    words: c.words || 0, content: c.content, fetched: true,
  }));
  const { error: chErr } = await supabase.from('chapters').insert(chapterRows);
  if (chErr) {
    // Roll back the orphan work so a retry doesn't leave a chapter-less stub.
    try { await supabase.from('works').delete().eq('id', work.id); } catch (e) {}
    return { ok: false, error: chErr.message || String(chErr) };
  }
  return { ok: true, work };
}
