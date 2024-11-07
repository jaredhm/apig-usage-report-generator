import {
  APIGatewayClient,
  ApiKey,
  GetApiKeysCommand,
  GetApiKeysCommandOutput,
  GetUsageCommand,
} from "@aws-sdk/client-api-gateway";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { DateTimeFormatter, LocalDate } from "@js-joda/core";
import assert from "assert";
import { stringify } from "csv-stringify";
import path from "path";
import { collect, concat } from "streaming-iterables";
import { ConfigKeys, Configurator } from "./Configurator";

// TODO: determine dynamically?
const EARLIEST_USAGE_DATE = LocalDate.parse(
  "2022-01-20",
  DateTimeFormatter.ofPattern("yyyy-MM-dd")
);

const dateFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd");

const later = (dateA: LocalDate, dateB: LocalDate) =>
  dateA.isBefore(dateB) ? dateB : dateA;

export class UsageReportHandler {
  private apiGatewayClient = new APIGatewayClient({});
  private s3Client = new S3Client({});

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
    const reportInterval = parseInt(
      (await this.configurator.tryGet(ConfigKeys.ReportIntervalDays)) ?? "7"
    );

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

  async run(): Promise<void> {
    const usagePlanId = await this.configurator.get(ConfigKeys.UsagePlanId);
    const s3Bucket = await this.configurator.get(ConfigKeys.OutputS3Bucket);
    const folder =
      (await this.configurator.tryGet(ConfigKeys.OutputS3Folder)) ?? ".";

    const allKeys = await collect(this.apiKeys());
    assert(
      allKeys.length <= 500,
      `Too many keys to run usage report: ${allKeys.length}`
    );

    const stringifier = stringify({
      delimiter: ",",
    });
    const s3Key = path.join(
      folder,
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
    for await (const row of allRows) {
      await new Promise<void>((resolve, reject) => {
        stringifier.write(row, "utf-8", (err) =>
          err ? reject(err) : resolve()
        );
      });
    }
    stringifier.end();
    await upload.done();
  }
}
