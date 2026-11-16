"use strict";

// Per-widget Jest settings consumed by the harness's root jest.config.js
// (discoverWidgetProjects reads testEnvironment / testEnvironmentOptions /
// testMatch from here). Both test layers live under tests/:
//   • view.controller.bootstrap.test.js — Layer 0 static + DI guard (needs DOM)
//   • render.pipeline.test.js           — Layer 1 pure render replay
//
// testEnvironmentOptions MUST be an object: jest-environment-jsdom@29 reads
// `testEnvironmentOptions.html` at construction, so a bare `undefined` (what the
// harness passes when this file is absent) crashes the env with
// "Cannot read properties of undefined (reading 'html')".
module.exports = {
  testEnvironment: "jsdom",
  testEnvironmentOptions: {},
  testMatch: ["<rootDir>/tests/**/*.test.js"],
};
