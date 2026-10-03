import { writeFileSync } from "node:fs";

export default class NormalTestMetadataReporter {
  onTestRunStart(specifications) {
    this.requestedFiles = specifications.map(specification => specification.moduleId);
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const outputFile = process.env.INDUSTRIAL_NORMAL_TEST_METADATA;
    if (!outputFile) throw new Error("Missing INDUSTRIAL_NORMAL_TEST_METADATA");
    writeFileSync(outputFile, JSON.stringify({
      reason,
      requestedFiles: this.requestedFiles,
      completedFiles: testModules.map(testModule => testModule.moduleId),
      unhandledErrors: unhandledErrors.map(error => ({
        name: error.name,
        message: error.message,
        cause: error.cause?.message,
      })),
    }));
  }
}
