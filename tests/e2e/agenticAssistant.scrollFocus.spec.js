'use strict';
// ─── B1/B2 -- transcript auto-scroll (pin-to-bottom) + composer focus restore ──
//
// B1: as messages append and the turn settles, the transcript stays pinned to
//     the bottom -- UNLESS the analyst has scrolled up to read history, in which
//     case their position is left alone; the analyst's OWN send always re-pins.
// B2: the composer regains focus once a user-sent turn returns to idle (it is
//     disabled mid-turn, so focus is restored on settle, not at send time).

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_isolated');
const { resolveWidgetId, DEFAULT_ID } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetId');

let WIDGET_ID = DEFAULT_ID;
test.beforeAll(async ({ request }) => { WIDGET_ID = await resolveWidgetId(request); });

async function boot(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript((id) => {
    localStorage.setItem('harness:config:' + id, JSON.stringify({
      connectorName: 'fortinet-fsr-playbook-builder', defaultIntent: 'triage',
      maxTurns: 10, seedFromEntity: false
    }));
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.removeItem('fsrPbSession');
  }, WIDGET_ID);
  await page.goto(
    `/?widget=${WIDGET_ID}&context=Dashboard&mock=happy_path&opener=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__agenticAssistant__ && typeof window.__agenticAssistant__.state === 'string',
    null, { timeout: 25000 });
  return errors;
}

const MESSAGES = '[data-testid="messages"]';
const INPUT = '[data-testid="chat-input"]';
const SEND = '[data-testid="chat-send"]';

// gap from the bottom of the scroll container, in px
async function bottomGap(page) {
  return page.locator(MESSAGES).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
}

async function sendAndSettle(page, text) {
  const before = await page.evaluate(() => window.__agenticAssistant__.messageCount);
  await page.locator(INPUT).fill(text);
  await page.locator(SEND).click();
  // The Send button disables on empty input (not only mid-turn), so gate on the
  // widget's exposed state: the user + assistant messages have landed AND the
  // turn has settled back to idle.
  await page.waitForFunction(
    (n) => { const w = window.__agenticAssistant__;
      return w && w.state === 'idle' && w.messageCount >= n + 2; },
    before, { timeout: 15000 });
}

test.describe('B1/B2 -- auto-scroll + composer focus', () => {
  test('B1: transcript is pinned to the bottom after sends; B2: composer regains focus', async ({ page }) => {
    const errors = await boot(page);
    await page.setViewportSize({ width: 720, height: 360 });   // force transcript overflow

    // A couple of turns -- happy_path returns a tall playbook message, so the
    // transcript overflows the container.
    await sendAndSettle(page, 'draft a playbook');
    await sendAndSettle(page, 'again please');
    await sendAndSettle(page, 'one more');   // overflow must not depend on how tall a message renders

    // B1 -- there is real overflow, and the container is pinned to the bottom.
    expect(await page.locator(MESSAGES).evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(48);
    expect(await bottomGap(page)).toBeLessThanOrEqual(48);

    // B2 -- focus is back in the composer, ready for the next message. The
    // widget refocuses the composer asynchronously after the turn settles, so
    // poll for it rather than sampling document.activeElement once (a single
    // synchronous read races the refocus and intermittently sees null).
    await expect.poll(
      () => page.evaluate(() =>
        document.activeElement && document.activeElement.getAttribute('data-testid')),
      { timeout: 5000 }
    ).toBe('chat-input');

    expect(errors, 'no console errors: ' + errors.join(' | ')).toEqual([]);
  });

  test('B1: scrolling up releases the pin; the analyst\'s own send re-pins', async ({ page }) => {
    await boot(page);
    // A short viewport so the transcript genuinely overflows its container.
    await page.setViewportSize({ width: 720, height: 360 });
    // Two tall turns so the transcript genuinely overflows the container.
    await sendAndSettle(page, 'draft a playbook');
    await sendAndSettle(page, 'again please');
    await sendAndSettle(page, 'one more');   // overflow must not depend on how tall a message renders
    expect(await bottomGap(page)).toBeLessThanOrEqual(48);
    // Sanity: there is real overflow to scroll through.
    expect(await page.locator(MESSAGES).evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(48);

    // Analyst scrolls up to read earlier content → pin releases.
    await page.locator(MESSAGES).evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    expect(await bottomGap(page)).toBeGreaterThan(48);

    // Their own next send always re-pins to the bottom (force path).
    await sendAndSettle(page, 'one more');
    expect(await bottomGap(page)).toBeLessThanOrEqual(48);
  });
});
