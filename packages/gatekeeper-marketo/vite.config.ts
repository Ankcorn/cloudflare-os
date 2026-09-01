import { withTests } from "../../scripts/gatekeeper-configurator-vite-config.js";

let tasks = withTests.run.tasks as Record<string, object>;

export default {
  ...withTests,
  run: {
    ...withTests.run,
    // The worker imports gitignored configurator output, so tests must generate it first.
    tasks: { ...tasks, test: { ...tasks.test, dependsOn: ["build:configurator"] } },
  },
};
