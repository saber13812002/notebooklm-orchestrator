import type { ProviderDescriptor } from "@nlo/shared";

/**
 * NLO-P4-1A: Provider Registry.
 *
 * An in-process, explicit registry of the providers this server knows about.
 * It is deliberately minimal and synchronous (no async init): the app builds
 * it at boot from the configured provider and hands it to the API layer.
 *
 * The registry is the SOLE source for `GET /api/v1/capabilities`: the route
 * never re-derives provider facts on its own — it reads the descriptors
 * registered here (which are themselves derived from the live provider's
 * honest capability matrix at boot).
 *
 * A provider may be registered with `status: "candidate"` or `"disabled"` to
 * keep its declared capabilities visible (e.g. an MCP client under
 * evaluation) without making it the ACTIVE provider.
 */
export interface ProviderRegistryEntry {
  descriptor: ProviderDescriptor;
  /** True when this descriptor belongs to the provider actually running. */
  active: boolean;
}

export class ProviderRegistry {
  private readonly entries = new Map<string, ProviderRegistryEntry>();

  /** Register (or replace) a provider by its descriptor id. */
  add(descriptor: ProviderDescriptor, active: boolean): this {
    this.entries.set(descriptor.id, { descriptor, active });
    return this;
  }

  /** All registered descriptors (stable order: insertion order). */
  list(): ProviderDescriptor[] {
    return [...this.entries.values()].map((e) => e.descriptor);
  }

  get(id: string): ProviderDescriptor | null {
    return this.entries.get(id)?.descriptor ?? null;
  }

  /** The active provider's id, or null if none is marked active. */
  activeId(): string | null {
    const active = [...this.entries.values()].find((e) => e.active);
    return active ? active.descriptor.id : null;
  }

  /**
   * The `GET /api/v1/capabilities` response body:
   *   { version: "1", providers: [descriptor...], activeId: string|null }
   * `version` is the CAPABILITIES CONTRACT version (bump on schema change).
   */
  capabilitiesResponse(): {
    version: string;
    providers: ProviderDescriptor[];
    activeId: string | null;
  } {
    return { version: "1", providers: this.list(), activeId: this.activeId() };
  }
}
