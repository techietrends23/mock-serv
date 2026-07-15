export class BrowserLauncher {
  private browser: any = null;

  async launch(): Promise<any> {
    const { chromium } = await import('playwright').catch(() => {
      throw new Error('playwright is not installed. Run: npm install playwright && npx playwright install chromium');
    });

    this.browser = await chromium.launch({
      headless: false,
      args: ['--ignore-certificate-errors']
    });

    const context = await this.browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    return { browser: this.browser, context, page };
  }

  async close(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    } catch {
    }
  }

  isRunning(): boolean {
    return this.browser !== null;
  }
}
