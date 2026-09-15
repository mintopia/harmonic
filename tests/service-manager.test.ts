import { describe, expect, it, vi } from 'vitest';
import {
  UnsupportedServicePlatformError,
  createServiceManager,
  type ServiceEnvironment,
} from '../src/service-manager.js';

const environment = (overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment => ({
  platform: 'linux',
  isRoot: false,
  systemdRunning: false,
  initdAvailable: false,
  userSystemdUsable: false,
  ...overrides,
});

describe('ServiceManager backend detection', () => {
  it('prefers a root systemd service over init.d', () => {
    expect(createServiceManager(environment({ isRoot: true, systemdRunning: true, initdAvailable: true })).backend).toBe('systemd');
  });

  it('uses init.d for root when systemd is not running', () => {
    expect(createServiceManager(environment({ isRoot: true, initdAvailable: true })).backend).toBe('init.d');
  });

  it('uses a user systemd service when available', () => {
    expect(createServiceManager(environment({ userSystemdUsable: true })).backend).toBe('user-systemd');
  });

  it('falls back to the self-managed daemon when no service manager fits', () => {
    expect(createServiceManager(environment()).backend).toBe('self-managed');
  });

  it.each(['darwin', 'win32'] as const)('rejects %s', (platform) => {
    expect(() => createServiceManager(environment({ platform }))).toThrow(UnsupportedServicePlatformError);
    expect(() => createServiceManager(environment({ platform }))).toThrow('only systemd/init.d supported');
  });

  it('reports that systemd and init.d installation is not yet available', async () => {
    await expect(createServiceManager(environment({ isRoot: true, systemdRunning: true })).install({ startSelfManaged: vi.fn() }))
      .rejects.toThrow('not yet available');
    await expect(createServiceManager(environment({ isRoot: true, initdAvailable: true })).install({ startSelfManaged: vi.fn() }))
      .rejects.toThrow('not yet available');
  });

  it('starts the standalone daemon and returns a boot-hook command on fallback install', async () => {
    const startSelfManaged = vi.fn(async () => {});
    const manager = createServiceManager(environment());

    await expect(manager.install({ startSelfManaged, bootCommand: 'harmonic start --data-dir /state' })).resolves.toEqual({
      backend: 'self-managed',
      bootCommand: 'harmonic start --data-dir /state',
    });
    expect(startSelfManaged).toHaveBeenCalledOnce();
    await expect(manager.isInstalled()).resolves.toBe(false);
  });
});
