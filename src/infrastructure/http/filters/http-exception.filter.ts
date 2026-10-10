import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Erro interno do servidor';
    let errorName = 'Internal Server Error';
    let failureCode: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        message = (body['message'] as string | string[]) || exception.message;
        errorName = (body['error'] as string) || exception.name;
        failureCode = body['failureCode'] as string | undefined;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`Exceção não tratada: ${exception.message}`, exception.stack);
    }

    const correlationId = (request.headers['x-correlation-id'] as string) || 'none';

    response.status(status).json({
      statusCode: status,
      error: errorName,
      message,
      failureCode,
      path: request.url,
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }
}
