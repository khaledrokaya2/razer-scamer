const logger = require("../utils/logger");

const LOGIN_URL = "https://razerid.razer.com";

class RazerLoginService {
  static normalizeComparable(value, { caseInsensitive = false } = {}) {
    let text = String(value || "")
      .normalize("NFC")
      .replace(/\u00a0/g, " ")
      .trim();
    if (caseInsensitive) {
      text = text.toLowerCase();
    }
    return text;
  }

  static describeMismatch(expected, actual) {
    const left = [...String(expected || "")];
    const right = [...String(actual || "")];
    const max = Math.max(left.length, right.length);
    for (let i = 0; i < max; i++) {
      if (left[i] !== right[i]) {
        return `diffAt=${i} expectedCode=${
          left[i] == null ? "EOF" : left[i].charCodeAt(0)
        } actualCode=${right[i] == null ? "EOF" : right[i].charCodeAt(0)}`;
      }
    }
    return "no-visible-diff";
  }

  static valuesMatch(expected, actual, selector) {
    const caseInsensitive = selector.includes("email");
    return (
      RazerLoginService.normalizeComparable(expected, { caseInsensitive }) ===
      RazerLoginService.normalizeComparable(actual, { caseInsensitive })
    );
  }

  /**
   * Fill a credential field once. Avoid erase/retype loops — razerid often
   * normalizes the displayed value (case/unicode), which made strict equality
   * fail and thrash the input even when typing succeeded.
   */
  static async setInputExact(page, selector, value) {
    const expected = String(value || "");
    const locator = page.locator(selector).first();

    await locator.waitFor({ state: "visible", timeout: 15000 });
    await locator.click({ timeout: 5000 });

    // Disable browser autofill interference on this field.
    await locator.evaluate((el) => {
      el.setAttribute("autocomplete", "off");
      el.setAttribute("autocapitalize", "off");
      el.setAttribute("spellcheck", "false");
    });

    // Playwright fill() is the reliable path for React-controlled inputs.
    await locator.fill(expected);

    let actualValue = String((await locator.inputValue()) || "");
    if (RazerLoginService.valuesMatch(expected, actualValue, selector)) {
      return;
    }

    logger.debug(
      `Credential field soft-mismatch after fill (${selector}): ` +
        `expectedLen=${expected.length} actualLen=${actualValue.length} ` +
        `${RazerLoginService.describeMismatch(expected, actualValue)}`,
    );

    // One human-like retry only if the field is empty/wrong length.
    if (actualValue.length === 0 && expected.length > 0) {
      await locator.click({ clickCount: 3, timeout: 5000 });
      await locator.pressSequentially(expected, { delay: 12 });
      actualValue = String((await locator.inputValue()) || "");
    }

    if (RazerLoginService.valuesMatch(expected, actualValue, selector)) {
      return;
    }

    // Field is populated with same-length content after a successful fill —
    // site-side normalization (common on email). Proceed instead of thrashing.
    if (expected.length > 0 && actualValue.length > 0) {
      logger.debug(
        `Accepting populated credential field (${selector}) despite strict mismatch ` +
          `(${RazerLoginService.describeMismatch(expected, actualValue)})`,
      );
      return;
    }

    throw new Error(`Failed to type credential field correctly (${selector})`);
  }

  /**
   * Execute the canonical login flow on an existing page.
   * @param {Object} page - Puppeteer page
   * @param {string} email - User email
   * @param {string} password - User password
   * @param {Object} options - Optional logger labels and timing
   */
  /**
   * True only for real Chromium error pages — NOT fresh about:blank.
   * A newly created Playwright page always starts on about:blank; that is normal.
   */
  static isChromeErrorUrl(url) {
    const href = String(url || "").toLowerCase();
    return (
      href.startsWith("chrome-error://") ||
      href.startsWith("chrome://") ||
      href.includes("neterror")
    );
  }

  /** @deprecated Use isChromeErrorUrl — about:blank alone is not a failure. */
  static isDeadPageUrl(url) {
    return RazerLoginService.isChromeErrorUrl(url);
  }

  /**
   * Only recover real chrome-error pages. Fresh about:blank is left alone —
   * loginOnPage will navigate to the login URL next.
   */
  static async ensurePageNavigable(page) {
    let currentUrl = "";
    try {
      currentUrl = page.url();
    } catch (_) {
      throw new Error("Login page is closed or unusable");
    }

    if (!RazerLoginService.isChromeErrorUrl(currentUrl)) {
      return;
    }

    logger.warn(
      `Login page is on Chromium error URL (${currentUrl}) - attempting recovery navigation`,
    );

    try {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
      await page.goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      });
    } catch (err) {
      throw new Error(
        `Login page stuck on chrome-error and recovery failed: ${err.message}`,
      );
    }

    if (RazerLoginService.isChromeErrorUrl(page.url())) {
      throw new Error("Login page still on chrome-error after recovery - browser must be recreated");
    }
  }

  static async loginOnPage(page, email, password, options = {}) {
    const labels = {
      open: options.openLabel || "Opening Razer login page...",
      wait: options.waitLabel || "Waiting for login form...",
      type: options.typeLabel || "Typing credentials...",
      submit: options.submitLabel || "Submitting login form...",
    };

    await RazerLoginService.ensurePageNavigable(page);

    logger.http(labels.open);
    try {
      await page.goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (gotoErr) {
      // One recovery pass for transient ERR_ABORTED / blank-page stalls.
      logger.warn(`Login goto failed (${gotoErr.message}) - recreating navigation once`);
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      await page.goto(LOGIN_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }

    if (RazerLoginService.isChromeErrorUrl(page.url())) {
      throw new Error("Login page landed on chrome-error after goto");
    }

    try {
      await page.waitForSelector('button[aria-label="Accept All"]', {
        visible: true,
        timeout: 8000,
      });
      await page.click('button[aria-label="Accept All"]');
      await new Promise((resolve) => setTimeout(resolve, 150));
      logger.debug("Cookie consent accepted");
    } catch (err) {
      logger.debug("No cookie consent banner");
    }

    logger.info(labels.wait);
    await page.waitForSelector("#input-login-email", {
      visible: true,
      timeout: 20000,
    });
    await page.waitForSelector("#input-login-password", {
      visible: true,
      timeout: 20000,
    });

    logger.info(labels.type);
    await RazerLoginService.setInputExact(
      page,
      "#input-login-email",
      String(email || "").trim(),
    );
    await RazerLoginService.setInputExact(
      page,
      "#input-login-password",
      String(password || ""),
    );

    try {
      await page.waitForSelector('button[aria-label="Accept All"]', {
        visible: true,
        timeout: 700,
      });
      await page.click('button[aria-label="Accept All"]');
      await new Promise((resolve) => setTimeout(resolve, 150));
      logger.debug("Cookie consent accepted");
    } catch (err) {
      logger.debug("No cookie consent banner");
    }

    logger.info(labels.submit);
    const urlBeforeSubmit = page.url();
    try {
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      ]);
    } catch (navErr) {
      const urlAfter = page.url();
      if (RazerLoginService.isChromeErrorUrl(urlAfter)) {
        throw new Error(
          `Login submit left page on chrome-error (${urlAfter}): ${navErr.message}`,
        );
      }
      // Wrong password often keeps the same login URL without a full navigation.
      if (urlAfter === urlBeforeSubmit || /razerid\.razer\.com\/?$/i.test(urlAfter)) {
        throw new Error("Login failed");
      }
      logger.debug(
        `Navigation wait timed out but URL changed to ${urlAfter} - continuing`,
      );
    }

    const currentUrl = page.url();
    if (RazerLoginService.isChromeErrorUrl(currentUrl)) {
      throw new Error(`Login ended on chrome-error URL: ${currentUrl}`);
    }

    const stillOnLoginRoot =
      currentUrl === "https://razerid.razer.com" ||
      currentUrl === "https://razerid.razer.com/";
    if (stillOnLoginRoot) {
      throw new Error("Login failed");
    }

    return currentUrl;
  }
}

module.exports = RazerLoginService;
