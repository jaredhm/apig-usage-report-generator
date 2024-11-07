import assert from "assert";
import {
  GetParametersByPathCommand,
  SSMClient
} from '@aws-sdk/client-ssm';

type PartialRecord<K extends string, T> = {
  [P in K]?: T;
};

export enum ConfigKeys {
  OutputS3Bucket = "OUTPUT_S3_BUCKET",
  OutputS3Folder = "OUTPUT_S3_FOLDER",
  UsagePlanId = "USAGE_PLAN_ID",
  ReportIntervalDays = "REPORT_INTERVAL_DAYS",
}

abstract class ConfigProvider {
  private booted = false;
  protected values: PartialRecord<ConfigKeys, string> = {};

  constructor() {}

  tryGet(key: ConfigKeys): string | null {
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
      this.values[key] = process.env[key];
    }
  }
}

export class ParameterStoreConfigProvider extends ConfigProvider {
  private ssmClient = new SSMClient({});

  async _bootInner(): Promise<void> {
    const parameterStoreNamespace = process.env["PARAMETER_STORE_NAMESPACE"];
    assert(
      typeof parameterStoreNamespace === 'string',
      "Expected PARAMETER_STORE_NAMESPACE in environment"
    );
    const getParametersByPathResult = await this.ssmClient.send(
      new GetParametersByPathCommand({
        Path: parameterStoreNamespace,
        WithDecryption: true,
      })
    );
    for (const key of Object.values(ConfigKeys)) {
      const param = getParametersByPathResult.Parameters?.find(
        ({ Name }) => Name?.toLowerCase() === key.toLowerCase()
      );
      if (param) {
        this.values[key] = param.Value;
      }
    }
  }
}

export class Configurator {
  constructor(private providers: Array<ConfigProvider> = [new EnvironmentConfigProvider()]) {}

  async tryGet(key: ConfigKeys): Promise<string | null> {
    await this.boot();
    for (const provider of this.providers) {
      const value = provider.tryGet(key);
      if (value) {
        return value;
      }
    }
    return null;
  }

  async get(key: ConfigKeys): Promise<string> {
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