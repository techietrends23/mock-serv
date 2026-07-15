import { chromium } from 'playwright';

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE', msg.text());
  });
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  const root = await page.evaluate(() => document.getElementById('root')?.innerHTML?.slice(0, 400) || '');
  const title = await page.title();
  const text = await page.locator('body').innerText().catch(() => '');
  console.log(
    JSON.stringify(
      {
        title,
        rootLen: root.length,
        rootPreview: root.slice(0, 200),
        textPreview: text.slice(0, 300)
      },
      null,
      2
    )
  );
  await page.screenshot({ path: '.mock-serv-data/ui-5175-fixed.png', fullPage: true });
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
