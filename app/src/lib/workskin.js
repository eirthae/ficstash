// Sanitize an AO3 "work skin" (the CSS that turns classed divs into chat bubbles,
// texting UIs, social-media cards) into something safe to apply in our reader.
//
// Three guarantees, in order of importance:
//   1. PROSE IS NEVER RESTYLED. We drop any rule whose selector targets a bare
//      element (p, div, body, a, …) or the #workskin root — those would override
//      the reader's own typography/line-height. Only rules that reference an
//      author CLASS or ID (i.e. a deliberately-styled block) survive. So your
//      font/size/leading/theme always win on ordinary paragraphs.
//   2. NO PHONE-HOME. url(http…) / protocol-relative url() and @import are
//      stripped (offline-first; on BookStash this is an F-Droid requirement). Only
//      inline data: URIs are kept.
//   3. CAN'T ESCAPE THE READER. Every surviving selector is prefixed with a scope
//      class, and position:fixed/sticky + absurd z-index are removed so nothing
//      breaks out of the chapter flow.
//
// AO3 serves work-skin CSS already prefixed with `#workskin`; we strip that and
// re-scope to our own container. Pure + dependency-free → unit-testable, and runs
// identically in the app and in node tests.

function stripRemote(s) {
  return String(s)
    // url(http://…), url(https://…), url(//…) → none. Keep data: URIs.
    .replace(/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\1\s*\)/gi, 'none')
    .replace(/@import[^;]+;?/gi, '');
}

function stripDangerousProps(body) {
  return String(body)
    .replace(/position\s*:\s*(fixed|sticky)\b[^;]*;?/gi, '')
    .replace(/z-index\s*:\s*-?\d{4,}\b[^;]*;?/gi, '');
}

// ---- readable text on author-coloured blocks --------------------------------
// Guarantee 1 (prose is never restyled) drops rules on bare elements — which is
// also where authors usually put the text colour that goes WITH their bubble
// background (`#workskin p { color:#eee }`). We keep the dark background and
// throw away the light text, so the reader's own colour applies: on a light
// theme that's near-black text on a dark bubble. Unreadable, and only on some
// themes, which is exactly how it was reported.
//
// So: when a surviving rule paints an opaque background and doesn't set its own
// colour, we work out whether that background is dark or light and supply a
// matching text colour. Author intent still wins whenever they expressed one.

// #rgb / #rrggbb / rgb() / rgba() → {r,g,b,a}. Named colours and gradients
// return null on purpose: guessing at `background: url(...)` or a gradient would
// be worse than leaving the block alone.
function parseColor(v) {
  const s = String(v || '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

// WCAG relative luminance (sRGB → linear, then the 0.2126/0.7152/0.0722 mix).
export function luminance({ r, g, b }) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The first opaque background colour a declaration block paints, or null.
// Semi-transparent backgrounds are skipped: what shows through is the reader
// theme, so the safe answer there is to leave the text colour alone.
function opaqueBackground(body) {
  const re = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/gi;
  let m;
  while ((m = re.exec(body))) {
    const value = m[1].trim();
    // A shorthand with an image/gradient — we can't know the effective colour.
    if (/url\(|gradient\(/i.test(value)) continue;
    // Pull the colour token out of a `background:` shorthand.
    const tok = value.match(/#[0-9a-fA-F]{3,6}\b|rgba?\([^)]*\)/);
    const col = parseColor(tok ? tok[0] : value);
    if (col && col.a >= 0.9) return col;
  }
  return null;
}

const declaresColor = (body) => /(?:^|;)\s*color\s*:/i.test(String(body));

// Text colour for a given background. Not pure black/white: those are harsh
// against a coloured bubble, and these two hit >12:1 contrast either way.
export function textColorFor(bg) {
  return luminance(bg) > 0.5 ? '#14161a' : '#f4f4f6';
}

// The rule that actually makes the text readable.
//
// It has to name descendants too, not just the block. `.reader-article p` sets
// colour DIRECTLY on every paragraph, and a directly-applied declaration always
// beats an inherited one regardless of specificity — so colouring only the
// bubble would still leave any <p> inside it on the reader's theme colour.
//
// The list is exactly the elements OUR reader CSS colours directly (see the
// `.reader-article …` rules in styles.css). Everything else — span, em, li, td —
// inherits correctly on its own, and naming it here would only widen the chance
// of overriding a colour the author did intend. Links are deliberately left
// alone: they stay accent-coloured rather than being repainted by us.
const TEXT_CHILDREN = ['p', 'strong', 'b', 'blockquote', 'h1', 'h2', 'h3'];

function contrastRule(selectors, color) {
  const targets = selectors.flatMap((sel) => [sel, ...TEXT_CHILDREN.map((el) => `${sel} ${el}`)]);
  return `${targets.join(', ')} { color: ${color}; }`;
}

// A selector is a "block" selector (safe to keep) if, after removing AO3's
// #workskin scoping prefix, it still references a class or id — i.e. it targets an
// element the author deliberately marked up, not bare prose.
function scopeSelector(sel, scope) {
  const bare = sel.replace(/#workskin\b/gi, '').trim();
  if (!bare) return null;            // a rule on the #workskin root → drop
  if (!/[.#]/.test(bare)) return null; // bare element (p, div, body…) → drop (protects prose)
  return `${scope} ${bare}`;
}

export function sanitizeWorkSkin(css, scope = '.ws-skin') {
  if (!css || typeof css !== 'string') return '';
  let s = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  s = s.replace(/@import[^;]+;?/gi, '');        // drop @import outright

  // Keep @keyframes (typing-dot animations etc.) as-is, minus remote refs; pull
  // them out so the flat rule parser below doesn't choke on nested braces.
  const keyframes = [];
  s = s.replace(/@(?:-webkit-)?keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, (m) => {
    keyframes.push(stripRemote(m));
    return '';
  });
  // Drop every other @-rule (media/supports/font-face) for v1 — rare in chat skins
  // and not worth the nested-brace parsing risk.
  s = s.replace(/@[\w-]+[^{;]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

  const out = [];
  const rules = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(s))) {
    const selectors = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    const kept = selectors.map((sel) => scopeSelector(sel, scope)).filter(Boolean);
    if (!kept.length) continue; // all selectors were prose/root → drop the rule
    const body = stripDangerousProps(stripRemote(m[2])).trim();
    if (!body) continue;
    out.push(`${kept.join(', ')} { ${body} }`);
    rules.push({ kept, body });
  }

  // Which selectors the author gave a colour ANYWHERE in the skin. Checking the
  // whole sheet, not just the rule carrying the background, matters because
  // authors routinely split them: `.msg { background:#222 }` in one rule and
  // `.msg { color:#eee }` in another. Repainting those would override a colour
  // they did choose.
  const authorColored = new Set();
  for (const r of rules) {
    if (declaresColor(r.body)) r.kept.forEach((sel) => authorColored.add(sel));
  }

  // Emitted after every author rule so that on equal specificity the later
  // declaration — ours — is the one that lands.
  const contrast = [];
  for (const r of rules) {
    if (declaresColor(r.body)) continue;
    const bg = opaqueBackground(r.body);
    if (!bg) continue;
    const targets = r.kept.filter((sel) => !authorColored.has(sel));
    if (targets.length) contrast.push(contrastRule(targets, textColorFor(bg)));
  }
  return [...keyframes, ...out, ...contrast].join('\n');
}

// Does a chapter's HTML actually use any of this skin's classed blocks? Cheap
// gate so we only show the "Author styling" toggle when there's something to style.
export function chapterUsesSkin(html) {
  return /\bclass\s*=/.test(String(html || ''));
}

// Safety net so the reader NEVER hotlinks a remote image (offline-first + privacy;
// on BookStash, an F-Droid requirement). The worker inlines real photos as data:
// URIs at capture — those are kept. Any remaining remote <img> (an old row, a
// missed/oversized one) is swapped for a small inline placeholder carrying its
// alt text. Idempotent and pure.
export function neutralizeRemoteImages(html) {
  if (!html || typeof html !== 'string') return html || '';
  if (!/<img/i.test(html)) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    if (/^data:/i.test(src)) return tag; // inlined photo — keep
    const alt = ((tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || 'image').replace(/[<>"]/g, '').trim() || 'image';
    return `<span class="fs-img-missing">📷 ${alt}</span>`;
  });
}
