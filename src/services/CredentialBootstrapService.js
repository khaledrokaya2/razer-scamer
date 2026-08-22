const logger = require("../utils/logger");
const appConfig = require("../config/app-config");
const encryptionService = require("../utils/encryption");

class CredentialBootstrapService {
  getMaxAttempts(override = null) {
    const raw =
      override != null
        ? override
        : appConfig.browser.credentialLoginMaxAttempts ?? 2;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
  }

  isBusyLockError(err) {
    const message = String(err?.message || err || "");
    return (
      err?.name === "BrowserBusyError" ||
      message.includes("currently busy with")
    );
  }

  /**
   * Attempt global ready-browser login with retry budget.
   * @param {string} telegramUserId
   * @param {{email: string, password: string}} credentials
   * @param {{maxAttempts?: number, forceRestart?: boolean, credentialsOverride?: object|null, skipBrowserLock?: boolean}} options
   */
  async tryGlobalLogin(telegramUserId, credentials, options = {}) {
    const purchaseService = require("./PurchaseService");
    const maxAttempts = this.getMaxAttempts(options.maxAttempts);
    const forceRestart = options.forceRestart !== false;
    const credentialsOverride =
      options.credentialsOverride !== undefined
        ? options.credentialsOverride
        : credentials;

    if (
      !credentialsOverride ||
      !credentialsOverride.email ||
      !credentialsOverride.password
    ) {
      return { success: false, readyResult: { count: 0, reason: "no_credentials" } };
    }

    const readyResult = await purchaseService.ensureReadyBrowsers(
      telegramUserId,
      {
        forceRestart,
        maxLoginAttempts: maxAttempts,
        credentialsOverride,
        skipBrowserLock: !!options.skipBrowserLock,
      },
    );

    const success = !!(readyResult && readyResult.count > 0);
    return { success, readyResult };
  }

  /**
   * Wipe stored credentials, backup codes, and close browsers.
   */
  async clearStoredAccount(telegramUserId) {
    const db = require("./DatabaseService");
    const purchaseService = require("./PurchaseService");
    const browserManager = require("./BrowserManager");
    const scopedUserId = db.getSharedOperatorUserId();

    logger.warn(
      `Clearing stored account for shared operator ${scopedUserId} after repeated login failure`,
    );

    await purchaseService.resetUserBrowsers(scopedUserId);

    for (const slotKey of browserManager.GLOBAL_BROWSER_SLOTS) {
      try {
        await browserManager.closeBrowser(slotKey);
      } catch (err) {
        logger.debug(`Error closing browser slot ${slotKey} during wipe: ${err.message}`);
      }
    }

    await db.deleteUserCredentials(scopedUserId);
    await db.deleteAllBackupCodes(scopedUserId);

    logger.system("Stored credentials and backup codes cleared");
    return true;
  }

  /**
   * Startup login using DB credentials.
   *
   * IMPORTANT: do NOT set browserManager busy here. ensureReadyBrowsers()
   * already acquires the busy lock. Holding both caused every bot restart to
   * fail with "busy with: startup" and then wipe credentials.
   */
  async bootstrapStartupLogin() {
    const db = require("./DatabaseService");
    const browserManager = require("./BrowserManager");
    const purchaseService = require("./PurchaseService");
    const sharedOperatorUserId = db.getSharedOperatorUserId();
    const maxAttempts = this.getMaxAttempts();

    let credentials;
    try {
      credentials = await db.getUserCredentials(sharedOperatorUserId);
    } catch (err) {
      logger.warn(`Could not check credentials at startup: ${err.message}`);
      return { outcome: "skipped", reason: "db_error" };
    }

    if (!credentials || !credentials.email || !credentials.password) {
      logger.system(
        "No credentials available - skipping browser startup. Browser will launch when credentials are provided.",
      );
      return { outcome: "skipped", reason: "no_credentials" };
    }

    try {
      const { success, readyResult } = await this.tryGlobalLogin(
        sharedOperatorUserId,
        credentials,
        {
          maxAttempts,
          forceRestart: true,
          credentialsOverride: credentials,
        },
      );

      if (!success) {
        await this.clearStoredAccount(sharedOperatorUserId);
        return { outcome: "cleared", readyResult };
      }

      browserManager.lastRestartTime = Date.now();

      try {
        await purchaseService.registerStartupBrowser();
      } catch (regErr) {
        logger.warn(
          `Failed to register startup browser in ready pool: ${regErr.message}`,
        );
      }

      browserManager.startAutoRestartTimer();
      logger.success("Browser initialized and logged in at startup");
      return { outcome: "ready", readyResult };
    } catch (err) {
      logger.error(`Browser startup failed: ${err.message}`);

      // Lock conflicts must never wipe saved credentials.
      if (this.isBusyLockError(err)) {
        return { outcome: "error", reason: err.message };
      }

      try {
        await this.clearStoredAccount(sharedOperatorUserId);
      } catch (clearErr) {
        logger.error(`Failed to clear account after startup error: ${clearErr.message}`);
      }

      return { outcome: "cleared", reason: err.message };
    }
  }

  /**
   * Scheduled restart login using DB credentials.
   * Caller (restartBrowser) already holds the busy lock.
   */
  async bootstrapRestartLogin() {
    const db = require("./DatabaseService");
    const browserManager = require("./BrowserManager");
    const purchaseService = require("./PurchaseService");
    const sharedOperatorUserId = db.getSharedOperatorUserId();
    const maxAttempts = this.getMaxAttempts();

    const credentials = await db.getUserCredentials(sharedOperatorUserId);
    if (!credentials || !credentials.email || !credentials.password) {
      throw new Error("No credentials found for browser restart relogin");
    }

    for (const slotKey of browserManager.GLOBAL_BROWSER_SLOTS) {
      try {
        await browserManager.closeBrowser(slotKey);
      } catch (err) {
        logger.debug(
          `Error closing browser slot ${slotKey} during restart bootstrap: ${err.message}`,
        );
      }
    }

    await purchaseService.resetUserBrowsers(sharedOperatorUserId);

    const { success, readyResult } = await this.tryGlobalLogin(
      sharedOperatorUserId,
      credentials,
      {
        maxAttempts,
        forceRestart: true,
        credentialsOverride: credentials,
        skipBrowserLock: true,
      },
    );

    if (!success) {
      await this.clearStoredAccount(sharedOperatorUserId);
      return { success: false, outcome: "cleared", readyResult };
    }

    try {
      await purchaseService.registerStartupBrowser();
    } catch (regErr) {
      logger.warn(
        `Failed to register restarted browser in ready pool: ${regErr.message}`,
      );
    }

    return { success: true, outcome: "ready", readyResult };
  }

  /**
   * Hard-close every global browser slot so the next login cannot reuse a stuck page.
   */
  async hardResetBrowsers(reason = "credential-phase-reset") {
    const browserManager = require("./BrowserManager");
    const purchaseService = require("./PurchaseService");
    const db = require("./DatabaseService");
    const scopedUserId = db.getSharedOperatorUserId();

    logger.system(`Hard-resetting browsers (${reason})...`);
    await purchaseService.resetUserBrowsers(scopedUserId);

    for (const slotKey of browserManager.GLOBAL_BROWSER_SLOTS) {
      try {
        await browserManager.closeBrowser(slotKey);
      } catch (err) {
        logger.debug(`Hard-reset close ${slotKey}: ${err.message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  /**
   * Test new credentials, fall back to previous, or wipe on total failure.
   */
  async applyCredentialChange(
    telegramUserId,
    newEmail,
    newPassword,
    previousCredentials,
  ) {
    const db = require("./DatabaseService");
    const scopedUserId = db.getSharedOperatorUserId();
    const maxAttempts = this.getMaxAttempts();

    await this.hardResetBrowsers("before-new-credentials");

    const newCredentials = {
      email: String(newEmail || "").trim(),
      password: String(newPassword || ""),
    };

    const newLogin = await this.tryGlobalLogin(scopedUserId, newCredentials, {
      maxAttempts,
      forceRestart: true,
      credentialsOverride: newCredentials,
    });

    if (newLogin.success) {
      const emailEncrypted = encryptionService.encrypt(newCredentials.email);
      const passwordEncrypted = encryptionService.encrypt(newCredentials.password);
      await db.saveUserCredentials(
        scopedUserId,
        emailEncrypted,
        passwordEncrypted,
      );
      await db.deleteAllBackupCodes(scopedUserId);
      logger.success(
        "New credentials saved and backup codes cleared after successful login",
      );
      return { outcome: "saved_new", readyResult: newLogin.readyResult };
    }

    const fallbackCredentials =
      previousCredentials &&
      previousCredentials.email &&
      previousCredentials.password
        ? previousCredentials
        : await db.getUserCredentials(scopedUserId);

    if (
      fallbackCredentials &&
      fallbackCredentials.email &&
      fallbackCredentials.password
    ) {
      logger.system(
        "New credentials failed - hard-resetting browser before fallback to saved credentials",
      );
      await this.hardResetBrowsers("before-fallback-credentials");

      const oldLogin = await this.tryGlobalLogin(
        scopedUserId,
        fallbackCredentials,
        {
          maxAttempts,
          forceRestart: true,
          credentialsOverride: fallbackCredentials,
        },
      );

      if (oldLogin.success) {
        logger.success(
          "Restored previous credentials after new credential login failed",
        );
        return {
          outcome: "restored_previous",
          readyResult: oldLogin.readyResult,
        };
      }
    }

    await this.clearStoredAccount(scopedUserId);
    return { outcome: "wiped" };
  }
}

module.exports = new CredentialBootstrapService();
