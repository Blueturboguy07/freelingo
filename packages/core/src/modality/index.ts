export { SUSPENSION_MS } from './config.js';
export {
  parseModalitySuspensions,
  remainingSuspensionMs,
  pruneExpiredSuspensions,
  suspendModality,
  clearModalitySuspension,
} from './suspension.js';
export type {
  ModalityClock,
  ModalityFamily,
  ModalitySuspensions,
  FamilySuspension,
} from './suspension.js';
