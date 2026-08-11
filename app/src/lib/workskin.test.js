import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWorkSkin, neutralizeRemoteImages } from './workskin.js';

test('keeps author class blocks, scoped', () => {
  const out = sanitizeWorkSkin('#workskin .text-message { color: blue; }', '.ws');
  assert.match(out, /\.ws\s+\.text-message\s*\{[^}]*color:\s*blue/);
});

test('drops bare-element rules so prose typography is never overridden', () => {
  const out = sanitizeWorkSkin('#workskin p { line-height: 3; font-family: Comic Sans; }', '.ws');
  assert.equal(out.trim(), ''); // a rule on bare <p> must not survive
});

test('drops a rule on the #workskin root itself', () => {
  const out = sanitizeWorkSkin('#workskin { background: black; color: white; }', '.ws');
  assert.equal(out.trim(), '');
});

test('strips remote url() and @import (no phone-home)', () => {
  const out = sanitizeWorkSkin('@import url(http://evil.com/x.css); #workskin .a { background: url("https://x.com/y.png"); }', '.ws');
  assert.ok(!/@import/i.test(out));
  assert.ok(!/https?:/i.test(out));
  assert.match(out, /\.ws\s+\.a/);
});

test('keeps inline data: URIs', () => {
  const out = sanitizeWorkSkin('#workskin .a { background: url(data:image/png;base64,AAAA); }', '.ws');
  assert.match(out, /data:image\/png/);
});

test('strips position:fixed/sticky so blocks cannot escape the flow', () => {
  const out = sanitizeWorkSkin('#workskin .a { position: fixed; color: red; }', '.ws');
  assert.ok(!/position\s*:\s*fixed/i.test(out));
  assert.match(out, /color:\s*red/);
});

test('a class rule with a nested bare element is kept (block-internal, not prose)', () => {
  const out = sanitizeWorkSkin('#workskin .chat p { margin: 0; }', '.ws');
  assert.match(out, /\.ws\s+\.chat p/);
});

test('handles unprefixed skins too', () => {
  const out = sanitizeWorkSkin('.bubble { border-radius: 12px; } span { color: red; }', '.ws');
  assert.match(out, /\.ws\s+\.bubble/);
  assert.ok(!/\bspan\b/.test(out)); // bare span dropped
});

test('empty / junk input is safe', () => {
  assert.equal(sanitizeWorkSkin(''), '');
  assert.equal(sanitizeWorkSkin(null), '');
  assert.equal(sanitizeWorkSkin('not css at all'), '');
});

test('neutralizeRemoteImages: remote <img> becomes a placeholder (no hotlink)', () => {
  const out = neutralizeRemoteImages('<p>x</p><img src="https://i.imgur.com/abc.jpg" alt="a selfie">');
  assert.ok(!/<img/i.test(out));
  assert.ok(!/imgur/i.test(out));
  assert.match(out, /fs-img-missing/);
  assert.match(out, /a selfie/);
});

test('neutralizeRemoteImages: keeps inlined data: images', () => {
  const html = '<img src="data:image/png;base64,AAAA" alt="post">';
  assert.equal(neutralizeRemoteImages(html), html);
});

test('neutralizeRemoteImages: protocol-relative + no-alt handled', () => {
  const out = neutralizeRemoteImages('<img src="//cdn.x/y.png">');
  assert.ok(!/<img/i.test(out));
  assert.match(out, /📷 image/);
});

test('neutralizeRemoteImages: no images → unchanged', () => {
  assert.equal(neutralizeRemoteImages('<p>just text</p>'), '<p>just text</p>');
});

// ---- readable text on author-coloured blocks -------------------------------
// The reported bug: chatfics where the author paints a dark bubble but declares
// their light text colour on a bare element (which sanitizeWorkSkin drops to
// protect prose typography). The reader's own colour then applies — near-black
// on a light theme — so the bubble is unreadable, and only on some themes.

test('a dark author background gets light text', () => {
  const out = sanitizeWorkSkin('#workskin .msg { background:#222222; padding:8px }', '.ws');
  assert.match(out, /\.ws \.msg[^{]*\{ color: #f4f4f6; \}/);
});

test('a light author background gets dark text', () => {
  const out = sanitizeWorkSkin('#workskin .msg { background:#eeeeee }', '.ws');
  assert.match(out, /color: #14161a/);
});

test('the contrast rule names <p> so it beats .reader-article p', () => {
  // .reader-article p sets color DIRECTLY, and a direct declaration beats an
  // inherited one at any specificity — colouring only .msg would not be enough.
  const out = sanitizeWorkSkin('#workskin .msg { background:#222 }', '.ws');
  assert.match(out, /\.ws \.msg p\b/);
  assert.match(out, /\.ws \.msg strong\b/);
});

test('an author colour on the same rule is left alone', () => {
  const out = sanitizeWorkSkin('#workskin .msg { background:#222; color:#0f0 }', '.ws');
  assert.match(out, /color:#0f0/);
  assert.equal(/color: #f4f4f6/.test(out), false);
});

test('an author colour in a SEPARATE rule is still respected', () => {
  const out = sanitizeWorkSkin('#workskin .msg { background:#222 } #workskin .msg { color:#0f0 }', '.ws');
  assert.equal(/color: #f4f4f6/.test(out), false);
});

test('rgb() and 3-digit hex backgrounds are understood', () => {
  assert.match(sanitizeWorkSkin('#workskin .a { background:rgb(20,20,20) }', '.ws'), /color: #f4f4f6/);
  assert.match(sanitizeWorkSkin('#workskin .b { background:#111 }', '.ws'), /color: #f4f4f6/);
});

test('a background colour inside a shorthand is found', () => {
  assert.match(sanitizeWorkSkin('#workskin .c { background:#1a1a1a none repeat }', '.ws'), /color: #f4f4f6/);
});

test('see-through and image backgrounds are left alone', () => {
  // What shows through is the reader theme, so its own text colour is correct.
  assert.equal(/color: #/.test(sanitizeWorkSkin('#workskin .d { background:rgba(0,0,0,.3) }', '.ws')), false);
  assert.equal(/color: #/.test(sanitizeWorkSkin('#workskin .e { background:linear-gradient(#000,#fff) }', '.ws')), false);
  assert.equal(/color: #/.test(sanitizeWorkSkin('#workskin .f { background:papayawhip }', '.ws')), false);
});

test('blocks with no background are untouched', () => {
  assert.equal(/color: #/.test(sanitizeWorkSkin('#workskin .g { padding:4px }', '.ws')), false);
});

test('prose is still never restyled', () => {
  // The original guarantee must survive: a bare-element rule contributes no
  // contrast rule either, or we would be colouring ordinary paragraphs.
  const out = sanitizeWorkSkin('#workskin p { background:#222 }', '.ws');
  assert.equal(out.trim(), '');
});
