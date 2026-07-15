import { EventEmitter } from 'node:events';

export interface ProxyCaptureEvent {
  method: string;
  url: string;
  host: string;
  path: string;
  queryString: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  contentType: string;
  durationMs: number;
  timestamp: string;
}

let requestCounter = 0;

export class CaptureController extends EventEmitter {
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private running: boolean = false;
  private pendingRequests: Map<
    number,
    { startTime: number; method: string; headers: Record<string, string>; url: string; body?: string }
  > = new Map();
  private urlToReqId: Map<string, number> = new Map();

  async start(): Promise<void> {
    const { chromium } = await import('playwright').catch(() => {
      throw new Error(
        'playwright is not installed. Run: npm install playwright && npx playwright install chromium'
      );
    });

    this.browser = await chromium.launch({
      headless: false,
      args: ['--ignore-certificate-errors']
    });

    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: true
    });

    this.page = await this.context.newPage();
    this.running = true;

    this.page.on('request', (request: any) => {
      const reqId = ++requestCounter;
      const reqUrl = request.url();
      if (!reqUrl.startsWith('http')) return;

      this.pendingRequests.set(reqId, {
        startTime: Date.now(),
        method: request.method(),
        headers: request.headers(),
        url: reqUrl,
        body: request.postData() || undefined
      });

      this.urlToReqId.set(reqUrl, reqId);
    });

    this.page.on('response', async (response: any) => {
      const url = response.url();
      if (!url.startsWith('http')) return;

      const reqId = this.urlToReqId.get(url);
      if (!reqId) return;

      const pending = this.pendingRequests.get(reqId);
      if (!pending) return;

      this.urlToReqId.delete(url);
      this.pendingRequests.delete(reqId);

      try {
        const resHeaders: Record<string, string> = {};
        const rawHeaders = response.headers();
        for (const [key, value] of Object.entries(rawHeaders)) {
          resHeaders[key] = String(value ?? '');
        }

        const contentType = resHeaders['content-type'] || resHeaders['Content-Type'] || '';

        let responseBody: unknown = undefined;
        try {
          const bodyBuffer = await response.body();
          if (bodyBuffer && bodyBuffer.length > 0) {
            const bodyStr = bodyBuffer.toString('utf-8');
            try {
              responseBody = JSON.parse(bodyStr);
            } catch {
              responseBody = bodyStr;
            }
          }
        } catch {
        }

        const parsedUrl = new URL(url);
        const event: ProxyCaptureEvent = {
          method: pending.method,
          url,
          host: parsedUrl.hostname,
          path: parsedUrl.pathname,
          queryString: parsedUrl.search,
          requestHeaders: pending.headers,
          requestBody: pending.body,
          responseStatus: response.status(),
          responseHeaders: resHeaders,
          responseBody,
          contentType,
          durationMs: Date.now() - pending.startTime,
          timestamp: new Date().toISOString()
        };

        this.emit('capture', event);
      } catch {
      }
    });

    this.page.on('requestfailed', (request: any) => {
      const url = request.url();
      if (!url.startsWith('http')) return;
      const reqId = this.urlToReqId.get(url);
      if (reqId) {
        this.pendingRequests.delete(reqId);
        this.urlToReqId.delete(url);
      }
    });

    this.page.on('requestfinished', (request: any) => {
      const url = request.url();
      if (!url.startsWith('http')) return;
      this.urlToReqId.delete(url);
    });

    await this.page.goto('about:blank').catch(() => {});
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('Capture not started');
    await this.page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pendingRequests.clear();
    this.urlToReqId.clear();
    try {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    } catch {
    }
    this.page = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  onCapture(handler: (event: ProxyCaptureEvent) => void): () => void {
    this.on('capture', handler);
    return () => {
      this.off('capture', handler);
    };
  }
}
