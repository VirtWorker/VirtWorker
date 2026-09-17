/**
 * 统一错误码与业务异常。
 * 渲染层只依据 code 决定提示策略，不解析 message 文本。
 */

const CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_STATE: 'INVALID_STATE',
  EXECUTOR_OFFLINE: 'EXECUTOR_OFFLINE',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL: 'INTERNAL'
};

class AppError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** 常用异常的快捷构造 */
const fail = {
  validation: (message, details) => new AppError(CODES.VALIDATION_FAILED, message, details),
  notFound: (message) => new AppError(CODES.NOT_FOUND, message),
  conflict: (message) => new AppError(CODES.CONFLICT, message),
  invalidState: (message) => new AppError(CODES.INVALID_STATE, message),
  executorOffline: (message) => new AppError(CODES.EXECUTOR_OFFLINE, message),
  storage: (message) => new AppError(CODES.STORAGE_ERROR, message),
  internal: (message) => new AppError(CODES.INTERNAL, message)
};

module.exports = { CODES, AppError, fail };