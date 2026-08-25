export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (message = 'Missing or invalid API key') => new ApiError(401, 'unauthorized', message);
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);
