import {
  APIGatewayClient,
  ApiKey,
  GetApiKeysCommand,
  GetApiKeysCommandOutput,
  GetUsageCommand,
} from "@aws-sdk/client-api-gateway";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DateTimeFormatter, LocalDate } from "@js-joda/core";
import assert from "assert";
import { stringify } from "csv-stringify";
import path from "path";
import pino from "pino";
import { collect, concat } from "streaming-iterables";
import { ConfigKeys, Configurator } from "./Configurator";

// TODO: determine dynamically?
const EARLIEST_USAGE_DATE = LocalDate.parse(
  "2022-01-20",
  DateTimeFormatter.ofPattern("yyyy-MM-dd")
);
const DEFAULT_INTERVAL_DAYS = 7;
const PRESIGNED_URL_EXPIRY_SECONDS = 3600 * 24 * 5;

const dateFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd");

const later = (dateA: LocalDate, dateB: LocalDate) =>
  dateA.isBefore(dateB) ? dateB : dateA;

export class UsageReportHandler {
  private apiGatewayClient = new APIGatewayClient({});
  private s3Client = new S3Client({});
  private sesClient = new SESClient({});

  constructor(private configurator: Configurator) {}

  private async *apiKeys() {
    let marker: string | undefined = undefined;
    do {
      const getApiKeysResult: GetApiKeysCommandOutput =
        await this.apiGatewayClient.send(
          new GetApiKeysCommand({
            position: marker,
          })
        );
      marker = getApiKeysResult.position;
      yield* getApiKeysResult.items ?? [];
    } while (marker);
  }

  private header(apiKeys: Array<ApiKey>) {
    const keyIds = apiKeys
      .map(({ id }) => id)
      .filter(<T>(id: T | undefined): id is T => Boolean(id))
      .sort();
    const keyMap = apiKeys.reduce((keys, key) => {
      return key.id
        ? {
            ...keys,
            [key.id]: key,
          }
        : keys;
    }, <Record<string, ApiKey>>{});
    return [
      "Range Start",
      "Range End",
      ...keyIds.map((id) => keyMap[id].name || id),
    ];
  }

  private async *rows(
    apiKeys: Array<ApiKey>,
    dateRange: {
      from: LocalDate;
      to: LocalDate;
    }
  ): AsyncIterable<Array<string | number>> {
    const keyIds = apiKeys
      .map(({ id }) => id)
      .filter(<T>(id: T | undefined): id is T => Boolean(id))
      .sort();
    const usagePlanId = await this.configurator.get(ConfigKeys.UsagePlanId);
    const reportInterval =
      (await this.configurator.tryGet(ConfigKeys.ReportIntervalDays)) ??
      DEFAULT_INTERVAL_DAYS;

    let endDate = dateRange.to;
    let startDate = endDate.minusDays(reportInterval);
    do {
      const getUsageResult = await this.apiGatewayClient.send(
        new GetUsageCommand({
          limit: 500,
          usagePlanId,
          endDate: endDate.format(dateFormat),
          startDate: startDate.format(dateFormat),
        })
      );
      const row = [
        startDate.format(dateFormat),
        endDate.format(dateFormat),
        ...keyIds.map((id) => {
          const usageMap = getUsageResult.items;
          if (!usageMap || !usageMap[id]) {
            return 0;
          }
          return usageMap[id].reduce(
            (acc, [used, _remaining]) => acc + used,
            0
          );
        }),
      ];

      yield row;

      endDate = startDate.minusDays(1);
      startDate = later(endDate.minusDays(reportInterval), dateRange.from);
    } while (endDate.isAfter(dateRange.from));
  }

  private async sendReport(recipient: string, s3Key: string) {
    const senderAddress =
      (await this.configurator.tryGet(ConfigKeys.SenderAddress)) ??
      "no-reply@localhost";
    const presignedUrl = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: await this.configurator.get(ConfigKeys.OutputS3Bucket),
        Key: s3Key,
      }),
      { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS }
    );
    await this.sesClient.send(
      new SendEmailCommand({
        Source: senderAddress,
        Destination: {
          ToAddresses: [recipient],
        },
        Message: {
          Subject: {
            Charset: "UTF-8",
            Data: "API Usage Report",
          },
          Body: {
            Html: {
              Charset: "UTF-8",
              Data: `<html><p>A new API usage report is ready <a href='${presignedUrl}'>here</a>. This link will expire in 5 days.<p></html>`,
            },
          },
        },
      })
    );
  }

  async run(parentLogger = pino()): Promise<void> {
    const usagePlanId = await this.configurator.get(ConfigKeys.UsagePlanId);
    const s3Bucket = await this.configurator.get(ConfigKeys.OutputS3Bucket);
    const s3Prefix =
      (await this.configurator.tryGet(ConfigKeys.OutputS3Folder)) ?? ".";
    const recipient = await this.configurator.tryGet(
      ConfigKeys.RecipientAddress
    );
    const logger = parentLogger.child({ usagePlanId, s3Bucket, s3Prefix });
    logger.info("Starting report generation");

    logger.debug("Fetching API keys associated with usage plan");
    const allKeys = await collect(this.apiKeys());
    assert(
      allKeys.length <= 500,
      `Too many keys to run usage report: ${allKeys.length}`
    );
    logger.debug(`Fetched ${allKeys.length} API keys`);

    const stringifier = stringify({
      delimiter: ",",
    });
    const s3Key = path.join(
      s3Prefix,
      `usage-${usagePlanId}-${LocalDate.now().format(dateFormat)}.csv`
    );
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Body: stringifier,
        Key: s3Key,
        Bucket: s3Bucket,
      },
    });

    const today = LocalDate.now();
    const dateRange = {
      to: today,
      from: EARLIEST_USAGE_DATE,
    };
    const allRows = concat(
      [this.header(allKeys)],
      this.rows(allKeys, dateRange)
    );

    let counter = 0;
    logger.debug(
      `Collecting rows for usage report between ${dateRange.from} and ${dateRange.to}`
    );
    for await (const row of allRows) {
      await new Promise<void>((resolve, reject) => {
        stringifier.write(row, "utf-8", (err) =>
          err ? reject(err) : resolve()
        );
      });
      counter++;
      if (counter % 10 === 0) {
        logger.debug(`${counter} rows written to report`);
      }
    }

    stringifier.end();
    const uploadResult = await upload.done();

    logger.info("Report uploaded to S3");

    if (uploadResult.Key && recipient) {
      logger.info("Sending report to destination address");
      await this.sendReport(recipient, uploadResult.Key);
      logger.info("Report sent");
    }

    logger.info("Done");
  }
}
