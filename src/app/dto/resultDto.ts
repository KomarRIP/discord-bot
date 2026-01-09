import type { ErrorCode } from "../../shared/errors/appError.js";

export type SuccessResultDto<T = unknown> = {
  type: "success";
  title: string;
  message: string;
  data?: T;
};

export type ErrorResultDto = {
  type: "error";
  errorCode: ErrorCode;
  userMessage: string;
  details?: unknown;
  retryable: boolean;
};

export type ResultDto<T = unknown> = SuccessResultDto<T> | ErrorResultDto;

