import express from 'express';
import client from 'prom-client';
import config, { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import { globalJobStore } from '../lib/globalJobStore';
import { RedisConsumerService } from '../connect/RedisConsumerService';

const app = express();

app.use(express.json());

// Initialize Redis consumer service
export const redisConsumerService = new RedisConsumerService();

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  // Use the job store's isBusy status
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  return res.status(200).json({ success: true, data: jobStoreBusy });
});

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Get current bot status
app.get('/status', async (req, res) => {
  const currentJob = globalJobStore.getCurrentJob();

  if (!currentJob) {
    return res.status(200).json({
      success: true,
      status: 'idle',
      statusMessage: 'No active session',
    });
  }

  return res.status(200).json({
    success: true,
    sessionId: currentJob.sessionId,
    botId: currentJob.botId,
    status: currentJob.status,
    statusMessage: currentJob.statusMessage,
    provider: currentJob.provider,
    meetingUrl: currentJob.meetingUrl,
    startedAt: currentJob.startedAt,
    joinedAt: currentJob.joinedAt,
    recordingStartedAt: currentJob.recordingStartedAt,
    participantCount: currentJob.participantCount,
    recordingUrl: currentJob.recordingUrl,
    error: currentJob.error,
  });
});

// Get status for a specific session
app.get('/status/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const currentJob = globalJobStore.getCurrentJob();

  // Since we only run one session at a time, check if the current job matches
  if (!currentJob || (currentJob.sessionId !== sessionId && currentJob.botId !== sessionId)) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  return res.status(200).json({
    success: true,
    sessionId: currentJob.sessionId,
    botId: currentJob.botId,
    status: currentJob.status,
    statusMessage: currentJob.statusMessage,
    provider: currentJob.provider,
    meetingUrl: currentJob.meetingUrl,
    startedAt: currentJob.startedAt,
    joinedAt: currentJob.joinedAt,
    recordingStartedAt: currentJob.recordingStartedAt,
    participantCount: currentJob.participantCount,
    recordingUrl: currentJob.recordingUrl,
    error: currentJob.error,
  });
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  // Use the job store's isBusy status for metrics
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  busyStatus.set(jobStoreBusy);
  isavailable.set(1 - jobStoreBusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/debug', async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

app.use('/google', googleRouter);
app.use('/microsoft', microsoftRouter);
app.use('/zoom', zoomRouter);

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// Start Redis consumer service only if Redis is enabled
if (config.isRedisEnabled) {
  redisConsumerService.start().catch((error) => {
    console.error('Failed to start Redis consumer service:', error);
  });
} else {
  console.info('Redis consumer service not started - Redis is disabled');
}

export default app;
