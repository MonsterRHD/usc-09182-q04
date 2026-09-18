// 领域错误：携带 HTTP 状态码与稳定错误码，便于渠道联调时区分
// 库存不足、锁定过期、重复回调等不同情况。
export class DomainError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new DomainError(400, 'BAD_REQUEST', msg, details);
export const conflict = (code, msg, details) => new DomainError(409, code, msg, details);
export const notFound = (what) => new DomainError(404, 'NOT_FOUND', `${what}不存在`, { resource: what });
