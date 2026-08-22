/**
 * Settings-only: unlock Razer ID backup codes via DB backup-code 2FA,
 * click Generate New Codes, scrape the fresh set, replace DB codes.
 * Does not touch PurchaseService checkout / purchase 2FA.
 */

const db = require("./DatabaseService");
const purchaseService = require("./PurchaseService");
const logger = require("../utils/logger");
const { sleep } = require("./purchase/timing");

const ACCOUNT_URL = "https://razerid.razer.com/account";
const CODES_URL = "https://razerid.razer.com/account/security/codes";
const TOTP_POST_URL_PART = "razer-otptoken-service.razer.com/totp/post";
const MAX_OTP_ATTEMPTS = 2;

class BackupCodeReloadService {
  /**
   * @param {string} telegramUserId
   * @param {{checkCancelled?: () => boolean}} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   codes?: string[],
   *   attemptsUsed?: number,
   *   errorCode?: string,
   *   message?: string
   * }>}
   */
  async reloadFreshBackupCodes(telegramUserId, options = {}) {
    const checkCancelled = options.checkCancelled || (() => false);
    this.throwIfCancelled(checkCancelled);

    const activeCount = await db.getActiveBackupCodeCount(telegramUserId);
    if (!activeCount || activeCount < 1) {
      return {
        ok: false,
        errorCode: "NO_ACTIVE_CODES",
        message:
          "No active backup codes. Add codes first (manual paste) or restore some before reload.",
      };
    }

    return purchaseService.runWithBrowserLock("backup-code-reload", async () => {
      this.throwIfCancelled(checkCancelled);

      const readySessions = purchaseService.getReadySessions(telegramUserId);
      if (!readySessions || readySessions.length === 0) {
        return {
          ok: false,
          errorCode: "NO_READY_BROWSER",
          message:
            "No ready browser session. Use /start and wait until browsers are ready.",
        };
      }

      const page = readySessions[0].page;
      let attemptsUsed = 0;

      try {
        await this.openAccountAndStartBackupOtp(page, checkCancelled);

        const unlockResult = await this.unlockWithBackupCodes(
          page,
          telegramUserId,
          activeCount,
          checkCancelled,
        );
        attemptsUsed = unlockResult.attemptsUsed;

        if (!unlockResult.ok) {
          return {
            ok: false,
            attemptsUsed,
            errorCode: unlockResult.errorCode || "OTP_FAILED",
            message:
              unlockResult.message ||
              "Reload failed — backup code verification failed.",
          };
        }

        this.throwIfCancelled(checkCancelled);
        await this.generateAndWaitForFreshCodes(page, checkCancelled);

        this.throwIfCancelled(checkCancelled);
        const codes = await this.scrapeActiveCodes(page);

        if (!codes.length) {
          return {
            ok: false,
            attemptsUsed,
            errorCode: "SCRAPE_EMPTY",
            message:
              "Generated codes page loaded but no active backup codes were found. Existing DB codes were left unchanged.",
          };
        }

        // Never overwrite DB if user cancelled
        this.throwIfCancelled(checkCancelled);
        await db.saveBackupCodes(telegramUserId, codes);

        return {
          ok: true,
          codes,
          attemptsUsed,
        };
      } catch (err) {
        if (err && err.code === "RELOAD_CANCELLED") {
          return {
            ok: false,
            attemptsUsed,
            errorCode: "CANCELLED",
            message:
              "Backup code reload cancelled. Existing codes were kept.",
          };
        }
        throw err;
      } finally {
        await this.restoreReadyHome(page);
      }
    });
  }

  throwIfCancelled(checkCancelled) {
    if (typeof checkCancelled === "function" && checkCancelled()) {
      const err = new Error("Backup code reload cancelled by user");
      err.code = "RELOAD_CANCELLED";
      throw err;
    }
  }

  /**
   * Race a promise against fast cancel polling (100ms) so /cancel is immediate.
   */
  async raceWithCancel(promise, checkCancelled, label = "operation") {
    this.throwIfCancelled(checkCancelled);

    let cancelled = false;
    let timer = null;
    const cancelWatch = new Promise((_, reject) => {
      timer = setInterval(() => {
        if (checkCancelled && checkCancelled()) {
          cancelled = true;
          clearInterval(timer);
          timer = null;
          const err = new Error(`Backup code reload cancelled during ${label}`);
          err.code = "RELOAD_CANCELLED";
          reject(err);
        }
      }, 100);
    });

    try {
      return await Promise.race([promise, cancelWatch]);
    } finally {
      if (timer) clearInterval(timer);
      if (cancelled) {
        // no-op; caller handles RELOAD_CANCELLED
      }
    }
  }

  async openAccountAndStartBackupOtp(page, checkCancelled = () => false) {
    logger.info("[backup-reload] Opening Razer ID account page");
    this.throwIfCancelled(checkCancelled);

    await this.raceWithCancel(
      page.goto(ACCOUNT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      }),
      checkCancelled,
      "goto account",
    );

    await this.raceWithCancel(
      page.waitForSelector("#section-backup-codes", { timeout: 30000 }),
      checkCancelled,
      "wait backup codes section",
    );
    this.throwIfCancelled(checkCancelled);
    await page.click("#section-backup-codes");

    await this.raceWithCancel(
      page.waitForFunction(
        () => {
          const modal = document.querySelector(".modal-one-time-password");
          return !!(
            modal &&
            (modal.classList.contains("show") ||
              modal.classList.contains("modal"))
          );
        },
        { timeout: 30000 },
      ),
      checkCancelled,
      "wait otp modal",
    );

    this.throwIfCancelled(checkCancelled);
    await this.clickButtonByText(
      page,
      /Choose a different method/i,
      checkCancelled,
      30000,
    );
    this.throwIfCancelled(checkCancelled);
    await this.clickButtonByText(
      page,
      /^Backup Codes$/i,
      checkCancelled,
      20000,
    );

    await this.raceWithCancel(
      page.waitForSelector("#otp-input-0", { timeout: 20000 }),
      checkCancelled,
      "wait backup otp inputs",
    );
    logger.info("[backup-reload] Backup code OTP modal ready");
  }

  /**
   * Try up to 2 active DB codes. Mark used only after digits are typed.
   */
  async unlockWithBackupCodes(
    page,
    telegramUserId,
    activeCount,
    checkCancelled = () => false,
  ) {
    this.throwIfCancelled(checkCancelled);
    const activeCodes = await db.getAllActiveBackupCodes(telegramUserId);
    if (!activeCodes.length) {
      return {
        ok: false,
        attemptsUsed: 0,
        errorCode: "NO_ACTIVE_CODES",
        message:
          "No active backup codes. Add codes first (manual paste) or restore some before reload.",
      };
    }

    const maxAttempts = Math.min(MAX_OTP_ATTEMPTS, activeCodes.length);
    let attemptsUsed = 0;

    for (let i = 0; i < maxAttempts; i++) {
      this.throwIfCancelled(checkCancelled);
      const entry = activeCodes[i];
      const code = String(entry.code || "").replace(/\D/g, "");
      if (!/^\d{8}$/.test(code)) {
        logger.warn(
          `[backup-reload] Skipping invalid stored code id=${entry.id}`,
        );
        continue;
      }

      attemptsUsed += 1;
      logger.info(
        `[backup-reload] OTP attempt ${attemptsUsed}/${maxAttempts} using code id=${entry.id}`,
      );

      const outcome = await this.enterBackupCodeAndWait(
        page,
        code,
        checkCancelled,
      );

      // Expire only after OTP entry (success or fail)
      try {
        await db.markBackupCodesAsUsedByIds([entry.id]);
      } catch (markErr) {
        logger.warn(
          `[backup-reload] Failed to mark code ${entry.id} used: ${markErr.message}`,
        );
      }

      if (outcome === "success") {
        return { ok: true, attemptsUsed };
      }

      if (i + 1 < maxAttempts) {
        await this.prepareModalForNextCode(page);
      }
    }

    const onlyOne = activeCount === 1 || activeCodes.length === 1;
    return {
      ok: false,
      attemptsUsed,
      errorCode: onlyOne ? "OTP_FAILED_SINGLE" : "OTP_FAILED",
      message: "Reload failed — backup code verification failed.",
    };
  }

  /**
   * @returns {Promise<'success'|'fail'>}
   */
  async enterBackupCodeAndWait(page, code, checkCancelled = () => false) {
    this.throwIfCancelled(checkCancelled);
    const totpResultPromise = this.waitForTotpPostResult(page, 45000);

    await this.raceWithCancel(
      page.waitForSelector("#otp-input-0", { timeout: 15000 }),
      checkCancelled,
      "wait otp input",
    );

    this.throwIfCancelled(checkCancelled);

    // Razer ID OTP fields are React-controlled + auto-advance.
    // Never triple-click / fill("") per box (that clears digits). Prefer:
    // 1) type full code into the first box (auto-advance), else
    // 2) native value setter + InputEvent (React-safe).
    await page.waitForSelector("#otp-input-0", { state: "visible", timeout: 15000 });
    await page.click("#otp-input-0");
    await page.keyboard.type(code, { delay: 30 });

    let filledCount = await page.evaluate(() => {
      let count = 0;
      for (let i = 0; i < 8; i++) {
        const el = document.querySelector(`#otp-input-${i}`);
        if (el && String(el.value || "").trim().length === 1) count++;
      }
      return count;
    });

    if (filledCount !== 8) {
      filledCount = await page.evaluate((fullCode) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        let count = 0;
        for (let i = 0; i < 8; i++) {
          const el = document.querySelector(`#otp-input-${i}`);
          if (!el) continue;
          el.focus();
          setter.call(el, fullCode[i] || "");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          if (String(el.value || "").trim().length === 1) count++;
        }
        // Blur last field to encourage auto-submit handlers
        const last = document.querySelector("#otp-input-7");
        if (last) last.blur();
        return count;
      }, code);
    }

    if (filledCount !== 8) {
      logger.warn(
        `[backup-reload] OTP fill incomplete (${filledCount}/8), retrying keyboard type`,
      );
      await page.click("#otp-input-0", { clickCount: 1 });
      // Clear via select-all + backspace once on first field only
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.type(code, { delay: 40 });
    }

    logger.info("[backup-reload] Backup code digits entered, waiting for result");

    const navPromise = page
      .waitForURL((url) => String(url).includes("/account/security/codes"), {
        timeout: 45000,
      })
      .then(() => "success")
      .catch(() => null);

    const failPromise = totpResultPromise.then((r) =>
      r === "fail" ? "fail" : null,
    );

    const stillOnModalPromise = (async () => {
      await sleep(8000);
      if (checkCancelled()) return "fail";
      if (String(page.url()).includes("/account/security/codes")) {
        return "success";
      }
      const onCodes = await page.evaluate(() => {
        return (
          !!document.querySelector("#btn-generate-new-codes") ||
          !!document.querySelector(".codes")
        );
      });
      if (onCodes) return "success";

      const modalVisible = await page.evaluate(
        () => !!document.querySelector("#otp-input-0"),
      );
      return modalVisible ? "fail" : null;
    })();

    const result = await Promise.race([
      navPromise,
      failPromise,
      stillOnModalPromise,
    ]);

    if (
      result === "success" ||
      String(page.url()).includes("/account/security/codes")
    ) {
      await page
        .waitForSelector("#btn-generate-new-codes, .codes", { timeout: 30000 })
        .catch(() => {});
      logger.success("[backup-reload] Reached backup codes page");
      return "success";
    }

    logger.warn("[backup-reload] Backup code OTP rejected or timed out");
    return "fail";
  }

  /**
   * @returns {Promise<'ok'|'fail'|'unknown'>}
   */
  waitForTotpPostResult(page, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        if (!settled) {
          settled = true;
          resolve("unknown");
        }
      }, timeoutMs);

      const onResponse = async (response) => {
        try {
          const url = response.url() || "";
          if (!url.includes(TOTP_POST_URL_PART)) return;
          const status = response.status();
          let bodyOk = true;
          try {
            const json = await response.json();
            if (
              json &&
              (json.success === false ||
                json.error ||
                json.status === "error" ||
                json.statusCode >= 400)
            ) {
              bodyOk = false;
            }
          } catch (_) {
            // non-json
          }

          if (status >= 400 || !bodyOk) {
            cleanup();
            if (!settled) {
              settled = true;
              resolve("fail");
            }
          } else if (status >= 200 && status < 300) {
            cleanup();
            if (!settled) {
              settled = true;
              resolve("ok");
            }
          }
        } catch (_) {
          // ignore listener errors
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        try {
          page.off("response", onResponse);
        } catch (_) {}
      };

      page.on("response", onResponse);
    });
  }

  async prepareModalForNextCode(page) {
    const hasInput = await page.evaluate(
      () => !!document.querySelector("#otp-input-0"),
    );
    if (!hasInput) {
      const switched = await this.clickButtonByText(
        page,
        /Choose a different method/i,
      ).catch(() => false);
      if (switched !== false) {
        await sleep(400);
        await this.clickButtonByText(page, /^Backup Codes$/i).catch(() => {});
      }
      await page.waitForSelector("#otp-input-0", { timeout: 15000 });
    }

    await page.evaluate(() => {
      for (let i = 0; i < 8; i++) {
        const el = document.querySelector(`#otp-input-${i}`);
        if (el) {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    });
    await sleep(400);
  }

  async generateAndWaitForFreshCodes(page, checkCancelled = () => false) {
    this.throwIfCancelled(checkCancelled);

    if (!String(page.url()).includes("/account/security/codes")) {
      await this.raceWithCancel(
        page.goto(CODES_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        }),
        checkCancelled,
        "goto codes page",
      );
    }

    await this.raceWithCancel(
      page.waitForSelector("#btn-generate-new-codes", { timeout: 30000 }),
      checkCancelled,
      "wait generate button",
    );

    const codesBefore = await this.scrapeActiveCodes(page);
    logger.info(
      `[backup-reload] Clicking Generate New Codes (had ${codesBefore.length} active)`,
    );

    this.throwIfCancelled(checkCancelled);

    page.once("dialog", async (dialog) => {
      try {
        await dialog.accept();
      } catch (_) {}
    });

    await page.click("#btn-generate-new-codes");

    await page
      .waitForFunction(
        () => {
          const buttons = [...document.querySelectorAll("button")];
          return buttons.some((b) =>
            /^(Generate|Confirm|Yes)$/i.test((b.textContent || "").trim()),
          );
        },
        { timeout: 2500 },
      )
      .then(async () => {
        await this.clickButtonByText(page, /^(Generate|Confirm|Yes)$/i);
      })
      .catch(() => {});

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      this.throwIfCancelled(checkCancelled);
      const codes = await this.scrapeActiveCodes(page);
      const disabledCount = await page.evaluate(
        () => document.querySelectorAll(".codes .item.disabled").length,
      );
      if (codes.length >= 10 && disabledCount === 0) {
        logger.success(`[backup-reload] Fresh codes ready (${codes.length})`);
        return;
      }
      if (
        codes.length >= 8 &&
        codesBefore.length > 0 &&
        codes.join(",") !== codesBefore.join(",")
      ) {
        logger.success(
          `[backup-reload] Codes refreshed (${codes.length} active)`,
        );
        return;
      }
      await sleep(500);
    }

    logger.warn("[backup-reload] Timed out waiting for fresh code set");
  }

  async scrapeActiveCodes(page) {
    return page.evaluate(() => {
      const items = [
        ...document.querySelectorAll(".codes .item:not(.disabled)"),
      ];
      const codes = items
        .map((el) =>
          [...el.querySelectorAll("span")]
            .map((s) => (s.textContent || "").trim())
            .join(""),
        )
        .filter((c) => /^\d{8}$/.test(c));
      return [...new Set(codes)];
    });
  }

  /**
   * Wait until a button matching pattern is visible, then click it.
   * Handles slow network / delayed modal rendering.
   */
  async clickButtonByText(
    page,
    pattern,
    checkCancelled = () => false,
    timeoutMs = 30000,
  ) {
    const source =
      pattern instanceof RegExp ? pattern.source : String(pattern);
    const flags = pattern instanceof RegExp ? pattern.flags : "i";

    await this.raceWithCancel(
      page.waitForFunction(
        ({ source: src, flags: fl }) => {
          const re = new RegExp(src, fl);
          const buttons = [...document.querySelectorAll("button")];
          const btn = buttons.find((b) =>
            re.test((b.textContent || "").trim()),
          );
          if (!btn) return false;
          const style = window.getComputedStyle(btn);
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            btn.offsetParent !== null
          );
        },
        { source, flags },
        { timeout: timeoutMs },
      ),
      checkCancelled,
      `wait button ${source}`,
    );

    this.throwIfCancelled(checkCancelled);

    const clicked = await page.evaluate(
      ({ source: src, flags: fl }) => {
        const re = new RegExp(src, fl);
        const buttons = [...document.querySelectorAll("button")];
        const btn = buttons.find((b) => re.test((b.textContent || "").trim()));
        if (!btn) return false;
        btn.scrollIntoView({ block: "center", inline: "center" });
        btn.click();
        return true;
      },
      { source, flags },
    );

    if (!clicked) {
      throw new Error(`Could not find button matching ${source}`);
    }
    return true;
  }

  async restoreReadyHome(page) {
    try {
      const homeUrl =
        purchaseService.READY_BROWSER_HOME_URL ||
        "https://gold.razer.com/global/en";
      await page.goto(homeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    } catch (err) {
      logger.debug(
        `[backup-reload] Could not restore gold home: ${err.message}`,
      );
    }
  }
}

module.exports = new BackupCodeReloadService();
