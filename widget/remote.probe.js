// Remote smoke test for agenticAssistant against a live SOAR.
// Called by `node scripts/widget.js verify-remote agenticAssistant`.
//
// Verifies (in this order, so chip checks run in a clean drawer):
//  - widget root + version badge render
//  - opener fires from mock fixture (chips appear)
//  - chips render horizontally with full labels (no tall ovals, no ellipsis)
//  - settings overlay opens with the real edit.html (not the SOAR SPA fallback)

"use strict";

module.exports = async function probe({ page, helpers }) {
  const { screenshot, log } = helpers;

  // ─── version badge ───────────────────────────────────────────────────
  const version = await page.$eval('[data-testid="widget-version"]', el => el.textContent.trim()).catch(() => null);
  if (!version || !/^v\d/.test(version)) throw new Error("version badge missing or malformed");
  log("version badge: " + version);

  // ─── trigger the opener turn ─────────────────────────────────────────
  // Mock is the default → composer is enabled → sending any message fires
  // the fixture's first chat_turn which returns a choice_card.
  let chips = await page.$$('button.pb-chip');
  if (chips.length < 2) {
    log("→ no chips yet; sending a message to trigger the opener");
    const input = await page.$('[data-testid="chat-input"]');
    const disabled = input ? await input.evaluate(el => el.hasAttribute('disabled')) : true;
    log(`   chat-input present=${!!input} disabled=${disabled}`);
    if (!input || disabled) {
      throw new Error("chat-input is missing or disabled — mock mode isn't active. Check that config.mockMode defaults to 'mock'.");
    }
    await input.fill('hello');
    await screenshot("10-pre-send.png");
    await page.click('[data-testid="chat-send"]');
    // Poll for up to 15s — default fixture has 1.5s delays per step.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      chips = await page.$$('button.pb-chip');
      if (chips.length >= 2) break;
      await page.waitForTimeout(500);
    }
  }
  await screenshot("15-after-send.png");
  if (chips.length < 2) {
    const state = await page.$eval('[data-testid="fsr-pb-root"]', el => el.getAttribute('data-state')).catch(() => 'unknown');
    const errBanner = await page.$eval('[data-testid="error-banner"]', el => el.textContent.trim()).catch(() => null);
    const msgCount = (await page.$$('.pb-message')).length;
    log(`   widget state=${state} messages=${msgCount} errorBanner=${errBanner || '(none)'}`);
    throw new Error("no chips appeared after sending — mock didn't return a choice_card. See 15-after-send.png.");
  }
  log(`${chips.length} chips on screen`);

  // ─── chip layout diagnosis ────────────────────────────────────────────
  // Full diagnosis: bounding box + computed style + which stylesheet wins.
  // Captures the "tall vertical oval" bug AND the "ellipsis truncation" bug.
  const diagnosis = await page.$$eval('button.pb-chip', (els) => {
    return els.slice(0, 3).map((el) => {
      const cs = window.getComputedStyle(el);
      const parent = el.parentElement;
      const pcs = parent ? window.getComputedStyle(parent) : null;
      const rect = el.getBoundingClientRect();

      const winners = { 'white-space': null, 'display': null, 'width': null, 'min-width': null, 'flex-shrink': null };
      const interesting = Object.keys(winners);
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules || []; } catch (_e) { continue; }
        for (const rule of Array.from(rules)) {
          if (!rule.selectorText || !rule.style) continue;
          let matches = false;
          try { matches = el.matches(rule.selectorText); } catch (_e) { continue; }
          if (!matches) continue;
          for (const prop of interesting) {
            const val = rule.style.getPropertyValue(prop);
            if (val) winners[prop] = { selector: rule.selectorText, value: val, sheet: (sheet.href || 'inline').split('/').pop() };
          }
        }
      }

      return {
        text: (el.textContent || '').trim().slice(0, 40),
        box: { w: Math.round(rect.width), h: Math.round(rect.height) },
        truncated: el.scrollWidth > el.clientWidth + 1,
        chip: {
          'white-space': cs.whiteSpace, 'display': cs.display, 'width': cs.width,
          'min-width': cs.minWidth, 'max-width': cs.maxWidth, 'flex-shrink': cs.flexShrink,
        },
        parent: pcs ? { 'display': pcs.display, 'flex-wrap': pcs.flexWrap, 'width': pcs.width } : null,
        winningRules: winners,
      };
    });
  });

  log("chip diagnosis:");
  for (const d of diagnosis) {
    log(`  "${d.text}" box=${d.box.w}x${d.box.h} truncated=${d.truncated}`);
    log(`    chip: ${JSON.stringify(d.chip)}`);
    log(`    parent: ${JSON.stringify(d.parent)}`);
    for (const [prop, w] of Object.entries(d.winningRules)) {
      if (w) log(`    rule ${prop}: "${w.value}" from "${w.selector}" in ${w.sheet}`);
    }
  }

  await screenshot("20-chips.png");

  const tall = diagnosis.filter(d => d.box.h > d.box.w * 1.4);
  if (tall.length > 0) {
    throw new Error(`${tall.length}/${diagnosis.length} chips render as tall ovals (h>w*1.4).`);
  }
  const truncated = diagnosis.filter(d => d.truncated);
  if (truncated.length > 0) {
    throw new Error(`${truncated.length} chip labels are truncated: ${JSON.stringify(truncated.map(d => d.text))}`);
  }
  log(`chips ok — horizontal, full labels visible`);

  // Card-prompt must not be squeezed to min-content (one-word-per-line).
  // That happens when SOAR's `.card` rule (display:flex; flex-direction:
  // column; align-items: flex-start) wins over ours.
  const promptDiag = await page.$$eval('.card-prompt', els => els.map(el => {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return {
      text: (el.textContent || '').trim().slice(0, 60),
      width: Math.round(r.width),
      height: Math.round(r.height),
      lineHeight: parseInt(cs.lineHeight, 10) || 16,
    };
  }));
  for (const p of promptDiag) {
    const lines = Math.round(p.height / p.lineHeight);
    log(`prompt "${p.text}" width=${p.width} lines≈${lines}`);
    // "PICK AN APPROACH:" is 16 chars; if it wraps to 3+ lines on a wide
    // drawer, something is squeezing the card width.
    if (lines >= 3 && p.text.length < 40) {
      throw new Error(`card-prompt "${p.text}" wraps to ${lines} lines — parent CSS is constraining card width to min-content. Likely SOAR's .card rule is winning.`);
    }
  }

  // ─── CSS bleed-through audit ─────────────────────────────────────────
  // Other installed widgets ship rules on generic class names (e.g. .card,
  // .chip, .step, .role, .message) that aren't scoped to their widget
  // root. Those rules leak into us and can clamp height/width or restyle
  // chrome we own. This probe scans every loaded stylesheet, finds any
  // rule whose rightmost simple selector targets a class used inside our
  // widget root, and whose selector chain is NOT anchored to our root
  // (`.fsr-pb-widget` or our widget id). Anything that lands in that
  // bucket and touches a layout-critical property is logged + fails CI.
  const widgetIdToken = 'agenticAssistant';
  const bleed = await page.evaluate((token) => {
    const root = document.querySelector('[data-testid="fsr-pb-root"]');
    if (!root) return { error: 'widget root missing' };
    const ourClasses = new Set();
    root.querySelectorAll('*').forEach(el => el.classList.forEach(c => ourClasses.add(c)));
    const LAYOUT_PROPS = new Set([
      'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
      'display', 'position', 'overflow', 'flex', 'flex-direction', 'flex-wrap',
      'align-content', 'align-items', 'justify-content', 'padding', 'margin'
    ]);
    const findings = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const href = sheet.href || '(inline)';
      if (href.includes(token)) continue; // skip our own widget's CSS
      let rules;
      try { rules = sheet.cssRules || []; } catch (e) { continue; /* cross-origin */ }
      for (const rule of Array.from(rules)) {
        if (!rule.selectorText || !rule.style) continue;
        for (const sel of rule.selectorText.split(',')) {
          const trimmed = sel.trim();
          if (!trimmed) continue;
          const m = trimmed.match(/\.([A-Za-z0-9_-]+)(?::[^\s>+~]*)?$/);
          if (!m) continue;
          if (!ourClasses.has(m[1])) continue;
          if (/\.fsr-pb-widget|agenticAssistant/.test(trimmed)) continue;
          // Selector must ACTUALLY match an element in our subtree —
          // otherwise the rightmost class collision is meaningless. e.g.
          // `.monaco-editor .message` matches `.message` but only when
          // nested under `.monaco-editor`, which our subtree never is.
          let matchEl = null;
          try {
            // Walk subtree + root itself; `root.querySelector` won't test the
            // root element, but our root has its own class set we care about.
            matchEl = root.querySelector(trimmed) || (root.matches(trimmed) ? root : null);
          } catch (e) { continue; /* invalid selector for querySelector */ }
          if (!matchEl) continue;
          const touched = [];
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style.item(i);
            if (LAYOUT_PROPS.has(prop)) {
              touched.push(prop + ': ' + rule.style.getPropertyValue(prop));
            }
          }
          if (touched.length) findings.push({ href: href, selector: trimmed, touched: touched });
        }
      }
    }
    return { findings: findings };
  }, widgetIdToken);
  if (bleed.error) throw new Error('css-bleed audit failed: ' + bleed.error);
  if (bleed.findings && bleed.findings.length) {
    log(`CSS BLEED — ${bleed.findings.length} foreign rule(s) target our classes:`);
    for (const f of bleed.findings) {
      log(`  ${f.selector}  [${f.touched.join('; ')}]  ← ${f.href}`);
    }
    throw new Error(`CSS bleed-through detected from ${bleed.findings.length} foreign rule(s) — see log above`);
  }
  log('CSS bleed audit: no foreign rules touching our classes');

  // ─── settings overlay loads real edit.html (last so it doesn't block earlier checks) ───
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-overlay"]', { timeout: 5000 });
  await page.waitForTimeout(600);
  await screenshot("30-settings.png");
  const panelHtml = await page.$eval(".settings-panel", el => el.innerHTML.slice(0, 4000));
  if (panelHtml.includes("<base") || /rel=["']stylesheet["']/.test(panelHtml)) {
    throw new Error("settings panel got the SOAR SPA index.html instead of the widget edit.html — ng-include path wrong");
  }
  if (!/cfg-mock-scenario|cfg-default-intent|cfg-close/i.test(panelHtml)) {
    throw new Error("settings panel missing expected agenticAssistant edit form fields");
  }
  log("settings overlay loaded the widget's edit.html");
};
