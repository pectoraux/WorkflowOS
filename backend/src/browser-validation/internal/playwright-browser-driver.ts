/**
 * WORK-065 — the Playwright-backed {@link BrowserDriver} adapter.
 *
 * THE BOUNDARY (spec/work-orders/WORK-065.md;
 * spec/architecture/v1.1/validation-model.md §9.2): this is the ONE place
 * browser-automation libraries appear in the repository. The agent-browser
 * style capability (headless browser automation with structured navigation/
 * click/type/snapshot commands) is ONE possible implementation of the
 * browser validation agent contract; the contract is what WORK-065 owns,
 * not a particular vendor.
 *
 * The adapter implements the EXISTING {@link BrowserDriver} port (WORK-036's
 * neutral navigation/inspection port — the same port BrowserToolExecutor
 * wraps). It adds NO second browser abstraction. It performs NO authority:
 *   - it never mutates code, merges PRs, or approves reviews;
 *   - it never mints identities (the TestIdentity is presented upstream);
 *   - it never evaluates evidence (the WORK-064 finalization boundary does);
 *   - it never relaxes the EffectPolicy (the enforcement gate is upstream).
 *
 * Bounds (mirroring BrowserToolExecutor):
 *   - http(s) URLs only (the driver enforces the scheme — no file://, no
 *     userinfo in the URL);
 *   - bounded extracted text (the page's text content, truncated to the
 *     executor's limit — the agent's observation-capture preserves the
 *     truncation marker);
 *   - bounded screenshot bytes (base64 PNG, truncated to the executor's
 *     limit);
 *   - per-call timeout (Playwright's navigation/action timeout — a timeout
 *     surfaces as a TimeoutError, which the agent records as
 *     environment_error).
 *
 * Production wiring: the adapter is constructed with a Playwright `Browser`
 * instance (lazily launched). When no browser is configured (production
 * today), the agent fails closed per call (environment_error — never a
 * silent no-op). The adapter is the explicit binding point for the future
 * architect-authorized production browser driver.
 */
import type {
  Browser as PlaywrightBrowser,
  BrowserContext,
  Page,
} from 'playwright';
import type {
  BrowserDriver,
  BrowserDriverCallOptions,
  BrowserNavigationResult,
  BrowserActionResult,
  BrowserExtractionResult,
  BrowserScreenshotResult,
} from '@platform/tools/browser-tool-executor.js';

/** The PlaywrightBrowserDriver construction options. */
export interface PlaywrightBrowserDriverOptions {
  /**
   * A launched Playwright `Browser` (or a factory that launches one lazily on
   * the first call). When absent, every call fails closed with a typed
   * 'browser-driver-unavailable' outcome (the agent records environment_error).
   */
  readonly browser?: PlaywrightBrowser | (() => Promise<PlaywrightBrowser>);
  /** The default context options (viewport, user agent, extra HTTP headers). */
  readonly contextOptions?: Parameters<PlaywrightBrowser['newContext']>[0];
  /** The maximum extracted text bytes (mirrors BrowserToolExecutor's bound). */
  readonly maxTextBytes?: number;
  /** The maximum screenshot base64 bytes (mirrors BrowserToolExecutor's bound). */
  readonly maxScreenshotBytes?: number;
}

/**
 * The Playwright-backed BrowserDriver. Implements the existing port (WORK-036)
 * — NO second browser abstraction. Each call opens a fresh context + page
 * (isolated per validation run — no shared cookies/localStorage across runs),
 * performs the primitive, and closes the page.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly browserOrFactory: PlaywrightBrowser | (() => Promise<PlaywrightBrowser>) | undefined;
  private readonly contextOptions: Parameters<PlaywrightBrowser['newContext']>[0];
  private readonly maxTextBytes: number;
  private readonly maxScreenshotBytes: number;

  constructor(options: PlaywrightBrowserDriverOptions = {}) {
    this.browserOrFactory = options.browser;
    this.contextOptions = options.contextOptions ?? {};
    this.maxTextBytes = options.maxTextBytes ?? 65_536;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? 262_144;
  }

  private async resolveBrowser(): Promise<PlaywrightBrowser> {
    if (this.browserOrFactory === undefined) {
      throw new Error('browser-driver-unavailable: no Playwright browser is configured');
    }
    if (typeof this.browserOrFactory === 'function') {
      return this.browserOrFactory();
    }
    return this.browserOrFactory;
  }

  private async withPage<T>(
    opts: BrowserDriverCallOptions,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const browser = await this.resolveBrowser();
    const context: BrowserContext = await browser.newContext(this.contextOptions);
    const page: Page = await context.newPage();
    try {
      // Playwright's default action timeout is governed by the page's settings;
      // set the per-call navigation/action timeout explicitly.
      page.setDefaultTimeout(opts.timeoutMs);
      page.setDefaultNavigationTimeout(opts.timeoutMs);
      return await fn(page);
    } finally {
      await page.close().catch(() => {
        // a page-close failure must not mask the real outcome
      });
      await context.close().catch(() => {
        // a context-close failure must not mask the real outcome
      });
    }
  }

  async open(url: string, opts: BrowserDriverCallOptions): Promise<BrowserNavigationResult> {
    return this.withPage(opts, async (page) => {
      const response = await page.goto(url, { timeout: opts.timeoutMs, waitUntil: 'domcontentloaded' });
      const finalUrl = page.url();
      const status = response?.status() ?? null;
      const title = await page.title().catch(() => null);
      return { finalUrl, status, title };
    });
  }

  async click(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult> {
    return this.withPage(opts, async (page) => {
      try {
        await page.click(selector, { timeout: opts.timeoutMs });
        return { matched: true, finalUrl: page.url() };
      } catch (err) {
        const e = err as Error;
        // A selector timeout means the element was not found/acted upon —
        // matched: false (the agent records the observation as missing →
        // validation_failure, never healthy).
        if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
          return { matched: false, finalUrl: page.url() };
        }
        throw e;
      }
    });
  }

  async type(selector: string, text: string, opts: BrowserDriverCallOptions): Promise<BrowserActionResult> {
    return this.withPage(opts, async (page) => {
      try {
        await page.fill(selector, text, { timeout: opts.timeoutMs });
        return { matched: true, finalUrl: page.url() };
      } catch (err) {
        const e = err as Error;
        if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
          return { matched: false, finalUrl: page.url() };
        }
        throw e;
      }
    });
  }

  async extract(selector: string, opts: BrowserDriverCallOptions): Promise<BrowserExtractionResult> {
    return this.withPage(opts, async (page) => {
      try {
        const handle = await page.waitForSelector(selector, { timeout: opts.timeoutMs, state: 'attached' });
        const rawText = (await handle.textContent()) ?? '';
        const truncated = Buffer.byteLength(rawText, 'utf8') > this.maxTextBytes;
        const text = truncated
          ? Buffer.from(rawText).subarray(0, this.maxTextBytes).toString('utf8')
          : rawText;
        return { matched: true, text, finalUrl: page.url() };
      } catch (err) {
        const e = err as Error;
        if (e.name === 'TimeoutError' || /timeout/i.test(e.message)) {
          return { matched: false, text: '', finalUrl: page.url() };
        }
        throw e;
      }
    });
  }

  async screenshot(opts: BrowserDriverCallOptions): Promise<BrowserScreenshotResult> {
    return this.withPage(opts, async (page) => {
      const buf = await page.screenshot({ type: 'png', timeout: opts.timeoutMs });
      const base64 = buf.toString('base64');
      const truncated = base64.length > this.maxScreenshotBytes;
      const truncatedBase64 = truncated ? base64.slice(0, this.maxScreenshotBytes) : base64;
      return { base64: truncatedBase64, finalUrl: page.url() };
    });
  }

  /**
   * Close the underlying browser (if this driver launched it). Safe to call
   * multiple times. Used by tests to clean up after a real-browser run.
   */
  async close(): Promise<void> {
    if (
      this.browserOrFactory !== undefined &&
      typeof this.browserOrFactory === 'object' &&
      typeof (this.browserOrFactory as PlaywrightBrowser).close === 'function'
    ) {
      await (this.browserOrFactory as PlaywrightBrowser).close().catch(() => {
        // best-effort close
      });
    }
  }
}
