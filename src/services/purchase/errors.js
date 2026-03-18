/**
 * Purchase domain errors.
 * Kept in a dedicated module to keep PurchaseService focused on orchestration.
 */

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

class InvalidBackupCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidBackupCodeError';
  }
}

class BackupCodeExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupCodeExpiredError';
  }
}

class TwoFactorVerificationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TwoFactorVerificationRequiredError';
  }
}

class TwoFactorRestartRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TwoFactorRestartRequiredError';
  }
}

module.exports = {
  InsufficientBalanceError,
  InvalidBackupCodeError,
  BackupCodeExpiredError,
  TwoFactorVerificationRequiredError,
  TwoFactorRestartRequiredError
};
