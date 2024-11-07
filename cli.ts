import {
  Configurator,
  EnvironmentConfigProvider,
} from "./Configurator";
import { UsageReportHandler } from "./UsageReportHandler";

if (require.main === module) {
  new UsageReportHandler(
    new Configurator([
      new EnvironmentConfigProvider(),
    ])
  ).run();
}
