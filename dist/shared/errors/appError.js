export class AppError extends Error {
    code;
    retryable;
    details;
    constructor(params) {
        super(params.message);
        this.name = "AppError";
        this.code = params.code;
        this.retryable = params.retryable ?? false;
        this.details = params.details;
    }
}
