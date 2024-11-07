import pino from "pino";
import {
  Configurator,
  EnvironmentConfigProvider,
} from "./Configurator";
import { UsageReportHandler } from "./UsageReportHandler";
import { config } from 'dotenv';

if (require.main === module) {
  config();
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'debug' });

  new UsageReportHandler(
    new Configurator([
      new EnvironmentConfigProvider(),
    ])
  ).run(logger);
}
