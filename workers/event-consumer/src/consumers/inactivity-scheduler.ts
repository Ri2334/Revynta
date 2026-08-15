import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '@revynta/config';
import { getActiveCampaignsForStore } from '@revynta/database';
import { logger } from '@revynta/observability';

// Setup connection options for BullMQ
export const queueRedisConnection = new Redis(config.redis.uri, {
  maxRetriesPerRequest: null,
});

export const inactivityQueue = new Queue('inactivity-evaluation-queue', {
  connection: queueRedisConnection,
});

export interface InactivityJobPayload {
  tenantId: string;
  sessionId: string;
  shopperId: string;
  campaignId: string;
  scheduledAt: string;
}

/**
 * Schedules or extends inactivity evaluation delayed jobs for all active campaigns in a store.
 */
export async function scheduleInactivityCheck(
  tenantId: string,
  sessionId: string,
  shopperId: string
): Promise<void> {
  try {
    const activeCampaigns = await getActiveCampaignsForStore(tenantId);
    if (!activeCampaigns || activeCampaigns.length === 0) {
      return;
    }

    const scheduledAt = new Date().toISOString();

    for (const campaign of activeCampaigns) {
      if (campaign.trigger_type !== 'browse_abandonment') {
        continue; // Phase 8 focus is browse abandonment
      }

      const jobId = `inactivity_${tenantId}_${sessionId}_${campaign.id}`;
      const delayMs = campaign.inactivity_duration_minutes * 60 * 1000;

      // Delayed Verification: Try to remove existing delayed job to extend inactivity timer
      try {
        const existingJob = await inactivityQueue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === 'delayed' || state === 'waiting' || state === 'failed') {
            await existingJob.remove();
            logger.debug({ jobId }, 'Removed existing delayed inactivity job');
          }
        }
      } catch (err) {
        // Safe check ignore
      }

      const payload: InactivityJobPayload = {
        tenantId,
        sessionId,
        shopperId,
        campaignId: campaign.id,
        scheduledAt,
      };

      await inactivityQueue.add('evaluate', payload, {
        jobId,
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: {
          age: 24 * 3600, // Keep failed jobs for up to 24 hours
          count: 1000,    // Keep at most 1000 failed jobs
        },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      });

      logger.debug(
        { tenantId, sessionId, campaignId: campaign.id, delayMinutes: campaign.inactivity_duration_minutes },
        'Scheduled inactivity evaluation job'
      );
    }
  } catch (error) {
    logger.error(error as Error, 'Failed to schedule inactivity checks');
  }
}
