'use strict';
// Runs one model bundle off the main thread so training never blocks HTTP.
const { parentPort, workerData } = require('worker_threads');
const { computeBundle } = require('./model');

const { ds, kind, horizonKey, opts } = workerData;
parentPort.postMessage(computeBundle(ds, kind, horizonKey, opts || {}));
