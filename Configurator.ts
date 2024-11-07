import assert from "assert";
import {
  GetParametersByPathCommand,
  SSMClient
} from '@aws-sdk/client-ssm';

export enum ConfigKeys {
  OutputS3Bucket = "OUTPUT_S3_BUCKET",
  OutputS3Folder = "OUTPUT_S3_FOLDER",
  SenderAddress = "SENDER_ADDRESS",
  RecipientAddress = "RECIPIENT_ADDRESS",
  UsagePlanId = "USAGE_PLAN_ID",
  ReportIntervalDays = "REPORT_INTERVAL_DAYS",
}

type ConfigTypes = {
  [ConfigKeys.OutputS3Bucket]: string,
  [ConfigKeys.OutputS3Folder]: string,
  [ConfigKeys.SenderAddress]: string,
  [ConfigKeys.RecipientAddress]: string,
  [ConfigKeys.UsagePlanId]: string,
  [ConfigKeys.ReportIntervalDays]: number
}

abstract class ConfigProvider {
  private booted = false;
  protected values: {[K in ConfigKeys]?: ConfigTypes[K]} = {};

  constructor() {}

  tryGet<T extends ConfigKeys>(key: T): ConfigTypes[T] | null {
    return this.values[key] ?? null;
  }
  get isBooted() {
    return this.booted;
  }
  async boot(): Promise<void> {
    await this._bootInner();
    this.booted = true;
  }

  protected abstract _bootInner(): Promise<void>;
}

export class EnvironmentConfigProvider extends ConfigProvider {
  async _bootInner(): Promise<void> {
    for (const key of Object.values(ConfigKeys)) {
      const value = process.env[key];
      if (value) {
        if (key === ConfigKeys.ReportIntervalDays) {
          this.values[key] = parseInt(value);
        } else {
          this.values[key] = value;
        }
      }
    }
  }
}

export class ParameterStoreConfigProvider extends ConfigProvider {
  private ssmClient = new SSMClient({});

  constructor(private parameterStoreNamespace: string) { super() }

  async _bootInner(): Promise<void> {
    const getParametersByPathResult = await this.ssmClient.send(
      new GetParametersByPathCommand({
        Path: this.parameterStoreNamespace,
        WithDecryption: true,
      })
    );
    for (const key of Object.values(ConfigKeys)) {
      const param = getParametersByPathResult.Parameters?.find(
        ({ Name }) => Name?.toLowerCase() === key.toLowerCase()
      );
      if (param?.Value) {
        if (key === ConfigKeys.ReportIntervalDays) {
          this.values[key] = parseInt(param.Value);
        } else {
          this.values[key] = param.Value;
        }
      }
    }
  }
}

export class Configurator {
  constructor(private providers: Array<ConfigProvider> = [new EnvironmentConfigProvider()]) {}

  async tryGet<T extends ConfigKeys>(key: T): Promise<ConfigTypes[T] | null> {
    await this.boot();
    for (const provider of this.providers) {
      const value = provider.tryGet(key);
      if (value) {
        return value;
      }
    }
    return null;
  }

  async get<T extends ConfigKeys>(key: T): Promise<ConfigTypes[T]> {
    const value = await this.tryGet(key);
    assert(
      value,
      `${key} missing from config provider(s)`
    );
    return value;
  }

  private async boot(): Promise<void> {
    for (const provider of this.providers) {
      if (!provider.isBooted) {
        await provider.boot();
      }
    }
  }
}