// Everything the worker needs for WhatsApp in one import: the runner plus
// every message kind's hooks and planner, which register themselves on import
// (each slice adds its module here).
import './fees.js';
import './academic.js';
import './retention.js';

export { createCommsRunner, registerPlanner } from './runner.js';
