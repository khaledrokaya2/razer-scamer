/**
 * Backup code parsing and validation helpers.
 */
function parseBackupCodes(inputText) {
  return String(inputText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function validateBackupCodes(codes, options = {}) {
  const {
    minCount = null,
    maxCount = null,
    exactCount = null,
    requireUnique = true,
    rejectUniformPattern = true
  } = options;

  const normalizedCodes = Array.isArray(codes) ? codes : [];

  if (typeof exactCount === 'number' && normalizedCodes.length !== exactCount) {
    return {
      isValid: false,
      type: 'count',
      details: { expected: exactCount, actual: normalizedCodes.length }
    };
  }

  if (typeof minCount === 'number' && normalizedCodes.length < minCount) {
    return {
      isValid: false,
      type: 'count',
      details: { min: minCount, max: maxCount, actual: normalizedCodes.length }
    };
  }

  if (typeof maxCount === 'number' && normalizedCodes.length > maxCount) {
    return {
      isValid: false,
      type: 'count',
      details: { min: minCount, max: maxCount, actual: normalizedCodes.length }
    };
  }

  const invalidFormatPositions = [];
  for (let i = 0; i < normalizedCodes.length; i++) {
    if (!/^\d{8}$/.test(normalizedCodes[i])) {
      invalidFormatPositions.push(i + 1);
    }
  }

  if (invalidFormatPositions.length > 0) {
    return {
      isValid: false,
      type: 'format',
      details: { positions: invalidFormatPositions }
    };
  }

  if (rejectUniformPattern) {
    const invalidPatternPositions = [];
    for (let i = 0; i < normalizedCodes.length; i++) {
      if (/^(.)\1{7}$/.test(normalizedCodes[i])) {
        invalidPatternPositions.push(i + 1);
      }
    }

    if (invalidPatternPositions.length > 0) {
      return {
        isValid: false,
        type: 'pattern',
        details: { positions: invalidPatternPositions }
      };
    }
  }

  if (requireUnique) {
    const uniqueCodes = new Set(normalizedCodes);
    if (uniqueCodes.size !== normalizedCodes.length) {
      return {
        isValid: false,
        type: 'duplicate',
        details: {}
      };
    }
  }

  return {
    isValid: true,
    type: null,
    details: {},
    codes: normalizedCodes
  };
}

function parseAndValidateBackupCodes(inputText, options = {}) {
  const codes = parseBackupCodes(inputText);
  const result = validateBackupCodes(codes, options);
  return {
    ...result,
    codes
  };
}

module.exports = {
  parseBackupCodes,
  validateBackupCodes,
  parseAndValidateBackupCodes
};
