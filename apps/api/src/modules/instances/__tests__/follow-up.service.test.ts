import { describe, it } from 'vitest';
// Stub — will fail until Plan 04 creates FollowUpService.
// import { FollowUpService } from '../follow-up.service.js';

describe('FollowUpService — 24h Window + Business Hours (FOL-01, FOL-02)', () => {
  it.todo('scheduleFollowUp within 24h window creates BullMQ job');
  it.todo('scheduleFollowUp outside 24h window returns blocked:true and no BullMQ job');
  it.todo('scheduleFollowUp outside business hours (21:00-08:00 Sao Paulo) returns blocked:true');
  it.todo('blocked follow-up persisted to ScheduledFollowUp table with status=blocked');
  it.todo('force-override flag logs override and creates BullMQ job despite 24h block');
});
