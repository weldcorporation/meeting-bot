import axios from 'axios';
import crypto from 'crypto';
import { Logger } from 'winston';
import config from '../config';
import { BotStatus, MeetingParticipant, RecordingMetrics } from '../types';

/**
 * Webhook event types for real-time status updates
 */
export type WebhookEvent =
  | 'bot.joining'
  | 'bot.joined'
  | 'bot.recording_started'
  | 'bot.recording_stopped'
  | 'bot.completed'
  | 'bot.failed'
  | 'bot.left'
  | 'bot.participant_update';

/**
 * Webhook payload structure
 */
export interface WebhookPayload {
  event: WebhookEvent;
  sessionId: string;
  botId?: string;
  timestamp: string;
  data: {
    status: BotStatus;
    statusMessage?: string;
    meetingUrl?: string;
    meetingPlatform?: 'google' | 'microsoft' | 'zoom';
    participantCount?: number;
    participants?: MeetingParticipant[];
    recordingMetrics?: RecordingMetrics;
    recordingUrl?: string;
    error?: {
      code: string;
      message: string;
      category?: string;
      subCategory?: string;
    };
    metadata?: Record<string, unknown>;
  };
}

/**
 * WebhookService handles real-time status notifications to external systems.
 * Sends events at each state transition during the meeting bot lifecycle.
 */
export class WebhookService {
  private logger: Logger;
  private webhookUrl?: string;
  private webhookSecret?: string;
  private retryAttempts: number;
  private retryDelayMs: number;

  constructor(
    logger: Logger,
    webhookUrl?: string,
    webhookSecret?: string,
    options?: { retryAttempts?: number; retryDelayMs?: number }
  ) {
    this.logger = logger;
    this.webhookUrl = webhookUrl || config.notifyWebhookUrl;
    this.webhookSecret = webhookSecret || config.notifyWebhookSecret;
    this.retryAttempts = options?.retryAttempts ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
  }

  /**
   * Generate HMAC-SHA256 signature for webhook payload
   */
  private sign(payload: string): string | undefined {
    if (!this.webhookSecret) return undefined;
    return crypto.createHmac('sha256', this.webhookSecret).update(payload).digest('hex');
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send a webhook event with retry logic
   */
  async send(
    event: WebhookEvent,
    payload: Omit<WebhookPayload, 'event' | 'timestamp'>
  ): Promise<boolean> {
    if (!config.notifyWebhookEnabled) {
      this.logger.debug('Webhook notifications disabled');
      return false;
    }

    if (!this.webhookUrl) {
      this.logger.debug('Webhook URL not configured');
      return false;
    }

    const fullPayload: WebhookPayload = {
      ...payload,
      event,
      timestamp: new Date().toISOString(),
    };

    const body = JSON.stringify(fullPayload);
    const signature = this.sign(body);

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        await axios.post(this.webhookUrl, body, {
          headers: {
            'Content-Type': 'application/json',
            ...(signature ? { 'X-Webhook-Signature': signature } : {}),
          },
          timeout: 10000,
        });

        this.logger.info(`Webhook ${event} delivered`, {
          sessionId: payload.sessionId,
          attempt,
        });
        return true;
      } catch (err: any) {
        const isLastAttempt = attempt === this.retryAttempts;

        if (isLastAttempt) {
          this.logger.error(`Failed to deliver webhook ${event} after ${this.retryAttempts} attempts`, {
            sessionId: payload.sessionId,
            error: err.message,
          });
          return false;
        }

        this.logger.warn(`Webhook ${event} delivery failed, retrying...`, {
          sessionId: payload.sessionId,
          attempt,
          error: err.message,
        });

        await this.sleep(this.retryDelayMs * attempt); // Exponential backoff
      }
    }

    return false;
  }

  // ============================================================
  // Convenience methods for common events
  // ============================================================

  /**
   * Send bot.joining event - when bot clicks "Ask to join"
   */
  async sendJoining(
    sessionId: string,
    botId?: string,
    meetingUrl?: string,
    meetingPlatform?: 'google' | 'microsoft' | 'zoom'
  ): Promise<boolean> {
    return this.send('bot.joining', {
      sessionId,
      botId,
      data: {
        status: 'joining',
        statusMessage: 'Bot is attempting to join the meeting...',
        meetingUrl,
        meetingPlatform,
      },
    });
  }

  /**
   * Send bot.joined event - when bot successfully enters meeting
   */
  async sendJoined(
    sessionId: string,
    botId?: string,
    participantCount?: number,
    meetingPlatform?: 'google' | 'microsoft' | 'zoom'
  ): Promise<boolean> {
    return this.send('bot.joined', {
      sessionId,
      botId,
      data: {
        status: 'joined',
        statusMessage: 'Bot successfully joined the meeting',
        participantCount,
        meetingPlatform,
      },
    });
  }

  /**
   * Send bot.recording_started event - when MediaRecorder starts
   */
  async sendRecordingStarted(
    sessionId: string,
    botId?: string,
    meetingPlatform?: 'google' | 'microsoft' | 'zoom'
  ): Promise<boolean> {
    return this.send('bot.recording_started', {
      sessionId,
      botId,
      data: {
        status: 'recording',
        statusMessage: 'Recording in progress',
        meetingPlatform,
        recordingMetrics: {
          startedAt: new Date().toISOString(),
          format: 'webm',
          hasAudio: true,
          hasVideo: true,
        },
      },
    });
  }

  /**
   * Send bot.recording_stopped event - when MediaRecorder stops
   */
  async sendRecordingStopped(
    sessionId: string,
    botId?: string,
    metrics?: Partial<RecordingMetrics>
  ): Promise<boolean> {
    return this.send('bot.recording_stopped', {
      sessionId,
      botId,
      data: {
        status: 'finished',
        statusMessage: 'Recording stopped',
        recordingMetrics: {
          startedAt: metrics?.startedAt || new Date().toISOString(),
          stoppedAt: new Date().toISOString(),
          duration: metrics?.duration,
          format: metrics?.format || 'webm',
          hasAudio: metrics?.hasAudio ?? true,
          hasVideo: metrics?.hasVideo ?? true,
        },
      },
    });
  }

  /**
   * Send bot.completed event - when recording is uploaded successfully
   */
  async sendCompleted(
    sessionId: string,
    botId?: string,
    recordingUrl?: string,
    metrics?: RecordingMetrics
  ): Promise<boolean> {
    return this.send('bot.completed', {
      sessionId,
      botId,
      data: {
        status: 'finished',
        statusMessage: 'Recording completed and uploaded',
        recordingUrl,
        recordingMetrics: metrics,
      },
    });
  }

  /**
   * Send bot.failed event - when an error occurs
   */
  async sendFailed(
    sessionId: string,
    error: { code: string; message: string; category?: string; subCategory?: string },
    botId?: string
  ): Promise<boolean> {
    return this.send('bot.failed', {
      sessionId,
      botId,
      data: {
        status: 'failed',
        statusMessage: error.message,
        error,
      },
    });
  }

  /**
   * Send bot.left event - when bot gracefully leaves the meeting
   */
  async sendLeft(
    sessionId: string,
    botId?: string,
    reason?: string
  ): Promise<boolean> {
    return this.send('bot.left', {
      sessionId,
      botId,
      data: {
        status: 'left',
        statusMessage: reason || 'Bot left the meeting',
      },
    });
  }

  /**
   * Send bot.participant_update event - when participant count changes
   */
  async sendParticipantUpdate(
    sessionId: string,
    participantCount: number,
    botId?: string
  ): Promise<boolean> {
    return this.send('bot.participant_update', {
      sessionId,
      botId,
      data: {
        status: 'recording',
        participantCount,
      },
    });
  }
}

/**
 * Create a WebhookService instance with default configuration
 */
export function createWebhookService(
  logger: Logger,
  webhookUrl?: string,
  webhookSecret?: string
): WebhookService {
  return new WebhookService(logger, webhookUrl, webhookSecret);
}
