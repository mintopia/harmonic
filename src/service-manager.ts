export type ServiceBackend = 'systemd' | 'init.d' | 'user-systemd' | 'self-managed';

export interface ServiceEnvironment {
  platform: NodeJS.Platform;
  isRoot: boolean;
  systemdRunning: boolean;
  initdAvailable: boolean;
  userSystemdUsable: boolean;
}

export interface ServiceInstallOptions {
  startSelfManaged: () => Promise<void>;
  bootCommand?: string;
}

export interface ServiceInstallResult {
  backend: ServiceBackend;
  bootCommand?: string;
}

export interface ServiceStatus {
  running: boolean;
  detail?: string;
}

export interface ServiceManager {
  readonly backend: ServiceBackend;
  install(options: ServiceInstallOptions): Promise<ServiceInstallResult>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}

export class UnsupportedServicePlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`Service installation is unsupported on ${platform}: only systemd/init.d supported.`);
    this.name = 'UnsupportedServicePlatformError';
  }
}

class UnavailableServiceManager implements ServiceManager {
  constructor(readonly backend: Exclude<ServiceBackend, 'self-managed'>) {}

  private unavailable(): never {
    throw new Error(`${this.backend} service support is not yet available.`);
  }

  async install(_options: ServiceInstallOptions): Promise<ServiceInstallResult> {
    return this.unavailable();
  }

  async uninstall(): Promise<void> {
    return this.unavailable();
  }

  async start(): Promise<void> {
    return this.unavailable();
  }

  async stop(): Promise<void> {
    return this.unavailable();
  }

  async restart(): Promise<void> {
    return this.unavailable();
  }

  async status(): Promise<ServiceStatus> {
    return this.unavailable();
  }

  async isInstalled(): Promise<boolean> {
    return false;
  }
}

class SelfManagedServiceManager implements ServiceManager {
  readonly backend = 'self-managed' as const;

  async install({ startSelfManaged, bootCommand }: ServiceInstallOptions): Promise<ServiceInstallResult> {
    await startSelfManaged();
    return { backend: this.backend, ...(bootCommand === undefined ? {} : { bootCommand }) };
  }

  async uninstall(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async restart(): Promise<void> {}

  async status(): Promise<ServiceStatus> {
    return { running: false };
  }

  async isInstalled(): Promise<boolean> {
    return false;
  }
}

export function createServiceManager(environment: ServiceEnvironment): ServiceManager {
  if (environment.platform !== 'linux') throw new UnsupportedServicePlatformError(environment.platform);
  if (environment.isRoot && environment.systemdRunning) return new UnavailableServiceManager('systemd');
  if (environment.isRoot && environment.initdAvailable) return new UnavailableServiceManager('init.d');
  if (environment.userSystemdUsable) return new UnavailableServiceManager('user-systemd');
  return new SelfManagedServiceManager();
}
