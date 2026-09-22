import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { browserFixture } from './browser-support.js';

const executable = process.env.CORTEX_BROWSER_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const available = existsSync(executable);
let fixture, browser, page;
before(async () => {
  if (!available) return;
  fixture = await browserFixture();
  browser = await chromium.launch({ executablePath: executable, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
});
after(async () => { await browser?.close(); await fixture?.close(); });

test('redesigned pages pass automated WCAG A/AA checks', { skip: !available && 'Set CORTEX_BROWSER_EXECUTABLE to run browser accessibility checks.' }, async () => {
  const findings = [];
  for (const route of ['/', '/cortex', '/build', '/build/new', '/share', '/share?kind=api-mcp&protocol=graphql', '/share?kind=m365', '/automate/new', '/help', '/about', '/agent/browser-agent', '/agent/browser-agent/assurance']) {
    await page.goto(fixture.url + route);
    await page.addScriptTag({ url: fixture.url + '/assets/vendor/axe.min.js' });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
      return result.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }));
    });
    if (violations.length) findings.push({ route, violations });
  }
  assert.deepEqual(findings, []);
});

test('chat opens as one accessible dialog, supports follow-up and Escape restores focus', { skip: !available }, async () => {
  await page.goto(fixture.url + '/agent/browser-agent');
  const launcher = page.getByRole('button', { name: 'Chat with this agent' });
  await launcher.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('textarea').fill('What source supports this?');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.locator('#latest').waitFor();
  assert.match(await dialog.innerText(), /What source supports this/);
  assert.equal(browser.contexts()[0].pages().length, 1);
  await page.addScriptTag({ url: fixture.url + '/assets/vendor/axe.min.js' });
  const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector('dialog'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
  })).violations.map((item) => item.id));
  assert.deepEqual(violations, []);
  await dialog.getByRole('button', { name: 'Expand', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: 'Shrink', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await launcher.evaluate((element) => element === document.activeElement), true);
});

test('automation starts at one step, adds a parallel step and preserves entered values', { skip: !available }, async () => {
  await page.goto(fixture.url + '/automate/new');
  assert.equal(await page.locator('[name^="stepAgent"]').count(), 1);
  await page.locator('#name').fill('My automation');
  await page.locator('#stepAgent1').selectOption('browser-agent');
  await page.locator('#stepInstruction1').fill('Read the data');
  await page.getByRole('button', { name: 'Add a new parallel step', exact: true }).click();
  assert.equal(await page.locator('[name^="stepAgent"]').count(), 2);
  assert.equal(await page.locator('#name').inputValue(), 'My automation');
  assert.equal(await page.locator('[name="stepStage2"]').inputValue(), '1');
});

test('chat browser audit records actual axe evidence and leaves manual review outstanding', { skip: !available }, async () => {
  await page.goto(fixture.url + '/agent/browser-agent/chat?audit=1');
  await page.getByRole('button', { name: 'Run WCAG browser checks' }).click();
  await page.waitForFunction(() => document.getElementById('audit-status')?.textContent.includes('Evidence saved'));
  await page.goto(fixture.url + '/agent/browser-agent/assurance');
  assert.match(await page.locator('main').innerText(), /automated rules passed/);
  assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixture.url + '/');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('Microsoft, Novo and Defra presentation retains accessible contrast and mobile reflow', { skip: !available }, async () => {
  const findings = [];
  try {
    for (const theme of ['microsoft', 'novo', 'defra']) {
      process.env.CORTEX_THEME = theme;
      await page.setViewportSize({ width: 1280, height: 900 });
      for (const route of ['/', '/about', '/share']) {
        await page.goto(fixture.url + route);
        await page.addScriptTag({ url: fixture.url + '/assets/vendor/axe.min.js' });
        const violations = await page.evaluate(async () => (await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
        })).violations.map((item) => ({ id: item.id, targets: item.nodes.map((node) => node.target) })));
        if (violations.length) findings.push({ theme, route, violations });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(fixture.url + '/');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, theme);
    }
  } finally { process.env.CORTEX_THEME = 'microsoft'; }
  assert.deepEqual(findings, []);
});

test('Try examples fill inputs without submitting or preselecting consent', { skip: !available }, async () => {
  await page.goto(fixture.url + '/ask');
  const before = page.url();
  await page.getByRole('button', { name: 'Use this example', exact: true }).click();
  assert.equal(page.url(), before);
  assert.match(await page.locator('#q').inputValue(), /synthetic Novo operations briefing/);
  await page.goto(fixture.url + '/share?kind=api-mcp&protocol=graphql');
  assert.match(await page.locator('#pub-query').inputValue(), /rows\(first: 2\)/);
  assert.equal(await page.locator('input[name="confirm"]').isChecked(), false);
});

test('request holder selection preserves the purpose and cadence entered by the user', { skip: !available }, async () => {
  await page.goto(fixture.url + '/requests?view=new');
  await page.locator('#question').fill('What sickness absence data is available?');
  await page.locator('#purpose').fill('Keep this purpose while I choose a holder.');
  await page.locator('#c-month').check();
  await page.getByRole('button', { name: 'Send the request', exact: true }).click();
  assert.ok(await page.locator('input[name="holderEntryId"]').count() > 0);
  assert.equal(await page.locator('#purpose').inputValue(), 'Keep this purpose while I choose a holder.');
  assert.equal(await page.locator('#c-month').isChecked(), true);
});
