const assert = require("assert");
const { listWaitEstimatorMethods } = require("../utils/waitEstimator");

function run() {
  const methods = listWaitEstimatorMethods();

  assert.ok(Array.isArray(methods), "Expected an array of method names");
  assert.deepStrictEqual(
    methods,
    ["getDoctorAverageMinutes", "estimateQueueByDoctor"],
    "Expected listWaitEstimatorMethods to return the method names"
  );

  console.log("✔ waitEstimator helper test passed");
}

run();
