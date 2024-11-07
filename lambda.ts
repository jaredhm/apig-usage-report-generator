import { EventBridgeEvent, Handler } from "aws-lambda";
import { Configurator, EnvironmentConfigProvider, ParameterStoreConfigProvider } from "./Configurator";
import { UsageReportHandler } from "./UsageReportHandler";
import pino from "pino";
import assert from "assert";

const handler: Handler<EventBridgeEvent<"Scheduled Event", string>> = async (event, context) => {
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'debug',
    base: {
      eventId: event.id,
      awsRequestId: context.awsRequestId,
      invokedFunctionArn: context.invokedFunctionArn
    }
  });
  assert(
    process.env.PARAMETER_STORE_NAMESPACE,
    "PARAMETER_STORE_NAMESPACE missing from environment"
  );
  await new UsageReportHandler(
    new Configurator([
      new ParameterStoreConfigProvider(process.env.PARAMETER_STORE_NAMESPACE),
      new EnvironmentConfigProvider(),
    ])
  ).run(logger);
}

export { handler };